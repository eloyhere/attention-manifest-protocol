/**
 * Tool-call boundary: parse arguments before anything touches the world.
 *
 * The reference executor passes `Record<string, unknown>` straight to a server.
 * This module checks the arguments against the tool's `inputSchema` and returns
 * a frozen copy plus a digest of exactly what was accepted, so an approval can
 * bind to the parsed call instead of to a mutable object.
 *
 * Contract:
 *  - `raw` must be a plain object whose values are strict JSON
 *    (`jsonValueProblem`); `undefined`, `NaN`, ±`Infinity`, functions,
 *    `symbol`/`BigInt`, `Date`/`Map`/`Set`, sparse arrays, cycles and accessors
 *    are rejected at the boundary instead of being silently rewritten by
 *    `JSON.stringify` (which would make the digest disagree with the wire).
 *  - the accepted arguments are a deep clone, frozen at every level, so the
 *    caller cannot mutate the call or its digest after approval.
 *  - the schema is JSON Schema restricted to `SupportedKeywords`. Local `$ref`
 *    targets (`#`, `#/$defs/<name>`, `#/definitions/<name>`) are resolved;
 *    every other applicator, and every malformed keyword form, is a schema
 *    problem rather than an ignored hint.
 *  - `not`/`contains`/`if`/`then`/`else`/`patternProperties`/`dependentSchemas`
 *    are intentionally not implemented: a schema that needs them is rejected
 *    (fail-closed) instead of being applied partially.
 *  - schema nesting is capped at 128 levels, far above the deepest schema MCP
 *    tools use, so legal deep schemas pass while `$ref` cycles terminate.
 */
import type { Digest } from "../types/common.ts";

import { canonical, digestOf } from "../semantic/canonical.ts";
import { cloneJson, deepFreezeJson, jsonValueProblem } from "../semantic/jsonValue.ts";
import { isDateTime } from "../semantic/time.ts";
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

/**
 * Deepest schema/value walk; a `$ref` cycle and an absurdly nested schema both
 * stop here with a schema problem instead of exhausting the stack.
 */
const MaxSchemaDepth: number = 128;

const JsonTypes: readonly string[] = ["null", "boolean", "object", "array", "string", "number", "integer"];

/**
 * Keywords that carry no constraint; their value is never interpreted.
 */
const AnnotationKeywords: readonly string[] = [
    "$schema",
    "$id",
    "title",
    "description",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
    "$comment",
    "$defs",
    "definitions",
];

/**
 * Applicators this validator understands. Anything else is fail-closed.
 */
const SupportedKeywords: readonly string[] = [
    "$ref",
    "type",
    "const",
    "enum",
    "allOf",
    "anyOf",
    "oneOf",
    "properties",
    "required",
    "additionalProperties",
    "minProperties",
    "maxProperties",
    "dependentRequired",
    "propertyNames",
    "items",
    "additionalItems",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
];

const SupportedFormats: readonly string[] = ["date-time", "date", "time", "email", "uri", "uuid"];

const DatePattern: RegExp = /^(\d{4})-(\d{2})-(\d{2})$/;
const TimePattern: RegExp = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const EmailPattern: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UriPattern: RegExp = /^[A-Za-z][A-Za-z0-9+.-]*:\S*$/;
const UuidPattern: RegExp = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const isPlainObject: (value: unknown) => value is Record<string, unknown> = (value: unknown): value is Record<string, unknown> => {
    if (typeof(value) !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    let prototype: object | null;
    try {
        prototype = Object.getPrototypeOf(value);
    } catch {
        return false;
    }
    return prototype === null || prototype === Object.prototype;
};

const isSchemaNode: (value: unknown) => boolean = (value: unknown): boolean => typeof(value) === "boolean" || isPlainObject(value);

type KeywordOf<T> = (schema: Record<string, unknown>, keyword: string, at: string, problems: string[]) => T | undefined;

const readString: KeywordOf<string> = (
    schema: Record<string, unknown>,
    keyword: string,
    at: string,
    problems: string[],
): string | undefined => {
    if (!Object.hasOwn(schema, keyword)) {
        return (void 0);
    }
    const value: unknown = schema[keyword];
    if (typeof(value) !== "string") {
        problems.push(`${at}: "${keyword}" must be a string`);
        return (void 0);
    }
    return value;
};

const readFiniteNumber: KeywordOf<number> = (
    schema: Record<string, unknown>,
    keyword: string,
    at: string,
    problems: string[],
): number | undefined => {
    if (!Object.hasOwn(schema, keyword)) {
        return (void 0);
    }
    const value: unknown = schema[keyword];
    if (typeof(value) !== "number" || !Number.isFinite(value)) {
        problems.push(`${at}: "${keyword}" must be a finite number`);
        return (void 0);
    }
    return value;
};

const readCount: KeywordOf<number> = (
    schema: Record<string, unknown>,
    keyword: string,
    at: string,
    problems: string[],
): number | undefined => {
    if (!Object.hasOwn(schema, keyword)) {
        return (void 0);
    }
    const value: unknown = schema[keyword];
    if (typeof(value) !== "number" || !Number.isInteger(value) || value < 0) {
        problems.push(`${at}: "${keyword}" must be a non-negative integer`);
        return (void 0);
    }
    return value;
};

const readBoolean: KeywordOf<boolean> = (
    schema: Record<string, unknown>,
    keyword: string,
    at: string,
    problems: string[],
): boolean | undefined => {
    if (!Object.hasOwn(schema, keyword)) {
        return (void 0);
    }
    const value: unknown = schema[keyword];
    if (typeof(value) !== "boolean") {
        problems.push(`${at}: "${keyword}" must be a boolean`);
        return (void 0);
    }
    return value;
};

const readPlainObject: KeywordOf<Record<string, unknown>> = (
    schema: Record<string, unknown>,
    keyword: string,
    at: string,
    problems: string[],
): Record<string, unknown> | undefined => {
    if (!Object.hasOwn(schema, keyword)) {
        return (void 0);
    }
    const value: unknown = schema[keyword];
    if (!isPlainObject(value)) {
        problems.push(`${at}: "${keyword}" must be an object`);
        return (void 0);
    }
    return value;
};

const readStringArray: KeywordOf<string[]> = (
    schema: Record<string, unknown>,
    keyword: string,
    at: string,
    problems: string[],
): string[] | undefined => {
    if (!Object.hasOwn(schema, keyword)) {
        return (void 0);
    }
    const value: unknown = schema[keyword];
    if (!Array.isArray(value)) {
        problems.push(`${at}: "${keyword}" must be an array of strings`);
        return (void 0);
    }
    let valid: boolean = true;
    for (let index: number = 0; index < value.length; index += 1) {
        if (typeof(value[index]) !== "string") {
            problems.push(`${at}: "${keyword}[${index}]" must be a string`);
            valid = false;
        }
    }
    if (!valid) {
        return (void 0);
    }
    return value as string[];
};

const readSchemaArray: KeywordOf<unknown[]> = (
    schema: Record<string, unknown>,
    keyword: string,
    at: string,
    problems: string[],
): unknown[] | undefined => {
    if (!Object.hasOwn(schema, keyword)) {
        return (void 0);
    }
    const value: unknown = schema[keyword];
    if (!Array.isArray(value) || value.length === 0) {
        problems.push(`${at}: "${keyword}" must be a non-empty array of schemas`);
        return (void 0);
    }
    let valid: boolean = true;
    for (let index: number = 0; index < value.length; index += 1) {
        if (!isSchemaNode(value[index])) {
            problems.push(`${at}: "${keyword}[${index}]" must be a schema`);
            valid = false;
        }
    }
    if (!valid) {
        return (void 0);
    }
    return value;
};

const readEnum: (schema: Record<string, unknown>, at: string, problems: string[]) => unknown[] | undefined = (
    schema: Record<string, unknown>,
    at: string,
    problems: string[],
): unknown[] | undefined => {
    if (!Object.hasOwn(schema, "enum")) {
        return (void 0);
    }
    const declared: unknown = schema.enum;
    if (!Array.isArray(declared) || declared.length === 0) {
        problems.push(`${at}: "enum" must be a non-empty array of JSON values`);
        return (void 0);
    }
    let valid: boolean = true;
    for (let index: number = 0; index < declared.length; index += 1) {
        const itemProblem: string | undefined = jsonValueProblem(declared[index], `${at}.enum[${index}]`);
        if (itemProblem !== (void 0)) {
            problems.push(`${at}: "enum[${index}]" is not JSON (${itemProblem})`);
            valid = false;
        }
    }
    if (!valid) {
        return (void 0);
    }
    return declared;
};

const readTypes: (schema: Record<string, unknown>, at: string, problems: string[]) => string[] | undefined = (
    schema: Record<string, unknown>,
    at: string,
    problems: string[],
): string[] | undefined => {
    if (!Object.hasOwn(schema, "type")) {
        return (void 0);
    }
    const declared: unknown = schema.type;
    const types: string[] = [];
    let valid: boolean = true;
    if (typeof(declared) === "string") {
        types.push(declared);
    } else if (Array.isArray(declared)) {
        if (declared.length === 0) {
            problems.push(`${at}: "type" must not be an empty array`);
            valid = false;
        }
        for (let index: number = 0; index < declared.length; index += 1) {
            const item: unknown = declared[index];
            if (typeof(item) !== "string") {
                problems.push(`${at}: "type[${index}]" must be a string`);
                valid = false;
            } else {
                types.push(item);
            }
        }
    } else {
        problems.push(`${at}: "type" must be a string or an array of strings`);
        return (void 0);
    }
    for (let index: number = 0; index < types.length; index += 1) {
        if (!JsonTypes.includes(types[index])) {
            problems.push(`${at}: unknown type "${types[index]}"`);
            valid = false;
        }
    }
    if (!valid) {
        return (void 0);
    }
    return types;
};

const sameJson: (left: unknown, right: unknown) => boolean = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

const daysInMonth: (year: number, month: number) => number = (year: number, month: number): number => {
    if (month === 2) {
        const leap: boolean = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
        return leap ? 29 : 28;
    }
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const isDate: (value: string) => boolean = (value: string): boolean => {
    const match: RegExpExecArray | null = DatePattern.exec(value);
    if (match === null) {
        return false;
    }
    const year: number = Number(match[1]);
    const month: number = Number(match[2]);
    const day: number = Number(match[3]);
    if (month < 1 || month > 12) {
        return false;
    }
    return day >= 1 && day <= daysInMonth(year, month);
};

const isTime: (value: string) => boolean = (value: string): boolean => {
    const match: RegExpExecArray | null = TimePattern.exec(value);
    if (match === null) {
        return false;
    }
    const hour: number = Number(match[1]);
    const minute: number = Number(match[2]);
    const second: number = Number(match[3]);
    if (hour > 23 || minute > 59 || second > 60) {
        return false;
    }
    if (second === 60 && (hour !== 23 || minute !== 59)) {
        return false;
    }
    if (match[5] !== "Z") {
        const offsetHour: number = Number(match[5].slice(1, 3));
        const offsetMinute: number = Number(match[5].slice(4, 6));
        if (offsetHour > 23 || offsetMinute > 59) {
            return false;
        }
    }
    return true;
};

const formatMatches: (format: string, value: string) => boolean = (format: string, value: string): boolean => {
    if (format === "date-time") {
        return isDateTime(value);
    }
    if (format === "date") {
        return isDate(value);
    }
    if (format === "time") {
        return isTime(value);
    }
    if (format === "email") {
        return EmailPattern.test(value);
    }
    if (format === "uri") {
        return UriPattern.test(value);
    }
    if (format === "uuid") {
        return UuidPattern.test(value);
    }
    return false;
};

const matchesType: (type: string, value: unknown) => boolean = (type: string, value: unknown): boolean => {
    if (type === "null") {
        return value === null;
    }
    if (type === "array") {
        return Array.isArray(value);
    }
    if (type === "object") {
        return isPlainObject(value);
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
    return false;
};

const decodePointer: (name: string) => string = (name: string): string => name.replaceAll("~1", "/").replaceAll("~0", "~");

type RefResolver = (ref: string, root: unknown, at: string, problems: string[]) => unknown;

/**
 * Resolve the three reference forms this validator accepts. Anything else —
 * external URLs, other pointers, missing definitions — is a schema problem.
 */
const resolveRef: RefResolver = (ref: string, root: unknown, at: string, problems: string[]): unknown => {
    if (ref === "#") {
        return root;
    }
    const prefixes: readonly string[] = ["#/$defs/", "#/definitions/"];
    for (let index: number = 0; index < prefixes.length; index += 1) {
        const prefix: string = prefixes[index];
        if (!ref.startsWith(prefix)) {
            continue;
        }
        const encoded: string = ref.slice(prefix.length);
        if (encoded.length === 0 || encoded.includes("/")) {
            break;
        }
        const name: string = decodePointer(encoded);
        const container: Record<string, unknown> | undefined = isPlainObject(root)
            ? isPlainObject(root[prefix === "#/$defs/" ? "$defs" : "definitions"])
                ? (root[prefix === "#/$defs/" ? "$defs" : "definitions"] as Record<string, unknown>)
                : (void 0)
            : (void 0);
        if (container === (void 0) || !Object.hasOwn(container, name)) {
            problems.push(`${at}: $ref "${ref}" cannot be resolved`);
            return (void 0);
        }
        const target: unknown = container[name];
        if (typeof(target) === "boolean" || isPlainObject(target)) {
            return target;
        }
        problems.push(`${at}: $ref "${ref}" does not point at a schema`);
        return (void 0);
    }
    problems.push(`${at}: $ref "${ref}" is not a local reference (only #, #/$defs/<name>, #/definitions/<name>)`);
    return (void 0);
};

type SchemaCheck = (schema: unknown, value: unknown, at: string, depth: number, root: unknown, problems: string[]) => void;

const schemaMatches: (schema: unknown, value: unknown, depth: number, root: unknown) => boolean = (
    schema: unknown,
    value: unknown,
    depth: number,
    root: unknown,
): boolean => {
    const problems: string[] = [];
    checkSchema(schema, value, "$", depth, root, problems);
    return problems.length === 0;
};

const checkObjectKeywords: SchemaCheck = (schema: unknown, value: unknown, at: string, depth: number, root: unknown, problems: string[]): void => {
    if (!isPlainObject(schema) || !isPlainObject(value)) {
        return;
    }
    const keys: string[] = Object.keys(value);

    const requiredNames: string[] | undefined = readStringArray(schema, "required", at, problems);
    if (requiredNames !== (void 0)) {
        for (let index: number = 0; index < requiredNames.length; index += 1) {
            const name: string = requiredNames[index];
            if (!Object.hasOwn(value, name)) {
                problems.push(`${at}.${name} is required`);
            }
        }
    }

    const hasProperties: boolean = Object.hasOwn(schema, "properties");
    const properties: Record<string, unknown> | undefined = readPlainObject(schema, "properties", at, problems);
    const hasAdditional: boolean = Object.hasOwn(schema, "additionalProperties");
    let additional: unknown = (void 0);
    let additionalValid: boolean = false;
    if (hasAdditional) {
        const declared: unknown = schema.additionalProperties;
        if (typeof(declared) === "boolean" || isPlainObject(declared)) {
            additional = declared;
            additionalValid = true;
        } else {
            problems.push(`${at}: "additionalProperties" must be a boolean or a schema`);
        }
    }

    if (!hasProperties && additionalValid && additional === false) {
        if (keys.length > 0) {
            problems.push(`${at} does not allow properties`);
        }
    } else {
        for (let index: number = 0; index < keys.length; index += 1) {
            const key: string = keys[index];
            const child: unknown = value[key];
            if (properties !== (void 0) && Object.hasOwn(properties, key)) {
                checkSchema(properties[key], child, `${at}.${key}`, depth + 1, root, problems);
            } else if (additionalValid && additional === false) {
                problems.push(`${at}.${key} is not allowed`);
            } else if (additionalValid && isPlainObject(additional)) {
                checkSchema(additional, child, `${at}.${key}`, depth + 1, root, problems);
            }
        }
    }

    const minProperties: number | undefined = readCount(schema, "minProperties", at, problems);
    if (minProperties !== (void 0) && keys.length < minProperties) {
        problems.push(`${at} needs at least ${minProperties} properties`);
    }
    const maxProperties: number | undefined = readCount(schema, "maxProperties", at, problems);
    if (maxProperties !== (void 0) && keys.length > maxProperties) {
        problems.push(`${at} allows at most ${maxProperties} properties`);
    }

    if (Object.hasOwn(schema, "dependentRequired")) {
        const dependent: unknown = schema.dependentRequired;
        if (!isPlainObject(dependent)) {
            problems.push(`${at}: "dependentRequired" must be an object`);
        } else {
            const triggers: string[] = Object.keys(dependent);
            for (let index: number = 0; index < triggers.length; index += 1) {
                const trigger: string = triggers[index];
                const dependency: unknown = dependent[trigger];
                if (!Array.isArray(dependency) || !dependency.every((item: unknown): boolean => typeof(item) === "string")) {
                    problems.push(`${at}: "dependentRequired.${trigger}" must be an array of strings`);
                    continue;
                }
                if (!Object.hasOwn(value, trigger)) {
                    continue;
                }
                for (let dependencyIndex: number = 0; dependencyIndex < dependency.length; dependencyIndex += 1) {
                    const name: string = dependency[dependencyIndex] as string;
                    if (!Object.hasOwn(value, name)) {
                        problems.push(`${at}.${name} is required when ${at}.${trigger} is present`);
                    }
                }
            }
        }
    }

    if (Object.hasOwn(schema, "propertyNames")) {
        const declared: unknown = schema.propertyNames;
        if (typeof(declared) !== "boolean" && !isPlainObject(declared)) {
            problems.push(`${at}: "propertyNames" must be an object or a boolean schema`);
        } else {
            for (let index: number = 0; index < keys.length; index += 1) {
                checkSchema(declared, keys[index], `${at}.${keys[index]}`, depth + 1, root, problems);
            }
        }
    }
};

const checkArrayKeywords: SchemaCheck = (schema: unknown, value: unknown, at: string, depth: number, root: unknown, problems: string[]): void => {
    if (!isPlainObject(schema) || !Array.isArray(value)) {
        return;
    }

    const hasItems: boolean = Object.hasOwn(schema, "items");
    let single: unknown = (void 0);
    let singleValid: boolean = false;
    let tuple: unknown[] | undefined = (void 0);
    if (hasItems) {
        const declared: unknown = schema.items;
        if (Array.isArray(declared)) {
            let valid: boolean = true;
            for (let index: number = 0; index < declared.length; index += 1) {
                if (!isSchemaNode(declared[index])) {
                    problems.push(`${at}: "items[${index}]" must be a schema`);
                    valid = false;
                }
            }
            if (valid) {
                tuple = declared;
            }
        } else if (typeof(declared) === "boolean" || isPlainObject(declared)) {
            single = declared;
            singleValid = true;
        } else {
            problems.push(`${at}: "items" must be an object, a boolean or an array of schemas`);
        }
    }

    if (tuple !== (void 0)) {
        for (let index: number = 0; index < tuple.length; index += 1) {
            if (index < value.length) {
                checkSchema(tuple[index], value[index], `${at}[${index}]`, depth + 1, root, problems);
            }
        }
        if (Object.hasOwn(schema, "additionalItems")) {
            const extra: unknown = schema.additionalItems;
            if (extra === false) {
                if (value.length > tuple.length) {
                    problems.push(`${at} allows at most ${tuple.length} items`);
                }
            } else if (typeof(extra) === "boolean" || isPlainObject(extra)) {
                for (let index: number = tuple.length; index < value.length; index += 1) {
                    checkSchema(extra, value[index], `${at}[${index}]`, depth + 1, root, problems);
                }
            } else {
                problems.push(`${at}: "additionalItems" must be a boolean or a schema`);
            }
        }
    } else {
        if (singleValid) {
            for (let index: number = 0; index < value.length; index += 1) {
                checkSchema(single, value[index], `${at}[${index}]`, depth + 1, root, problems);
            }
        }
        if (Object.hasOwn(schema, "additionalItems") && !Array.isArray(schema.items)) {
            problems.push(`${at}: "additionalItems" requires "items" to be an array of schemas`);
        }
    }

    const minItems: number | undefined = readCount(schema, "minItems", at, problems);
    if (minItems !== (void 0) && value.length < minItems) {
        problems.push(`${at} needs at least ${minItems} items`);
    }
    const maxItems: number | undefined = readCount(schema, "maxItems", at, problems);
    if (maxItems !== (void 0) && value.length > maxItems) {
        problems.push(`${at} allows at most ${maxItems} items`);
    }
    const uniqueItems: boolean | undefined = readBoolean(schema, "uniqueItems", at, problems);
    if (uniqueItems === true) {
        const seen: Set<string> = new Set<string>();
        for (let index: number = 0; index < value.length; index += 1) {
            const key: string = canonical(value[index]);
            if (seen.has(key)) {
                problems.push(`${at}[${index}] duplicates an earlier item`);
            } else {
                seen.add(key);
            }
        }
    }
};

type StringKeywordCheck = (
    schema: Record<string, unknown>,
    value: string,
    at: string,
    problems: string[],
    pattern: RegExp | undefined,
    patternSource: string | undefined,
    format: string | undefined,
) => void;

const checkStringKeywords: StringKeywordCheck = (
    schema: Record<string, unknown>,
    value: string,
    at: string,
    problems: string[],
    pattern: RegExp | undefined,
    patternSource: string | undefined,
    format: string | undefined,
): void => {
    const length: number = Array.from(value).length;
    const minLength: number | undefined = readCount(schema, "minLength", at, problems);
    if (minLength !== (void 0) && length < minLength) {
        problems.push(`${at} is shorter than ${minLength}`);
    }
    const maxLength: number | undefined = readCount(schema, "maxLength", at, problems);
    if (maxLength !== (void 0) && length > maxLength) {
        problems.push(`${at} is longer than ${maxLength}`);
    }
    if (pattern !== (void 0) && !pattern.test(value)) {
        problems.push(`${at} does not match ${patternSource}`);
    }
    if (format !== (void 0) && !formatMatches(format, value)) {
        problems.push(`${at} is not a valid ${format}`);
    }
};

const checkNumberKeywords: SchemaCheck = (schema: unknown, value: unknown, at: string, _depth: number, _root: unknown, problems: string[]): void => {
    if (!isPlainObject(schema) || typeof(value) !== "number") {
        return;
    }
    const minimum: number | undefined = readFiniteNumber(schema, "minimum", at, problems);
    if (minimum !== (void 0) && value < minimum) {
        problems.push(`${at} is below ${minimum}`);
    }
    const maximum: number | undefined = readFiniteNumber(schema, "maximum", at, problems);
    if (maximum !== (void 0) && value > maximum) {
        problems.push(`${at} is above ${maximum}`);
    }

    let exclusiveMinimum: number | undefined = (void 0);
    if (Object.hasOwn(schema, "exclusiveMinimum")) {
        const declared: unknown = schema.exclusiveMinimum;
        if (typeof(declared) === "number" && Number.isFinite(declared)) {
            exclusiveMinimum = declared;
        } else if (declared === true) {
            if (minimum === (void 0)) {
                problems.push(`${at}: "exclusiveMinimum" requires a numeric "minimum"`);
            } else {
                exclusiveMinimum = minimum;
            }
        } else if (declared !== false) {
            problems.push(`${at}: "exclusiveMinimum" must be a number or a boolean`);
        }
    }
    if (exclusiveMinimum !== (void 0) && value <= exclusiveMinimum) {
        problems.push(`${at} must be greater than ${exclusiveMinimum}`);
    }

    let exclusiveMaximum: number | undefined = (void 0);
    if (Object.hasOwn(schema, "exclusiveMaximum")) {
        const declared: unknown = schema.exclusiveMaximum;
        if (typeof(declared) === "number" && Number.isFinite(declared)) {
            exclusiveMaximum = declared;
        } else if (declared === true) {
            if (maximum === (void 0)) {
                problems.push(`${at}: "exclusiveMaximum" requires a numeric "maximum"`);
            } else {
                exclusiveMaximum = maximum;
            }
        } else if (declared !== false) {
            problems.push(`${at}: "exclusiveMaximum" must be a number or a boolean`);
        }
    }
    if (exclusiveMaximum !== (void 0) && value >= exclusiveMaximum) {
        problems.push(`${at} must be less than ${exclusiveMaximum}`);
    }

    if (Object.hasOwn(schema, "multipleOf")) {
        const declared: unknown = schema.multipleOf;
        if (typeof(declared) !== "number" || !Number.isFinite(declared) || declared <= 0) {
            problems.push(`${at}: "multipleOf" must be a positive finite number`);
        } else {
            const quotient: number = value / declared;
            if (Math.abs(quotient - Math.round(quotient)) > 1e-9 * Math.max(1, Math.abs(quotient))) {
                problems.push(`${at} is not a multiple of ${declared}`);
            }
        }
    }
};

const checkSchema: SchemaCheck = (schema: unknown, value: unknown, at: string, depth: number, root: unknown, problems: string[]): void => {
    if (depth > MaxSchemaDepth) {
        problems.push(`${at}: schema nesting exceeds ${MaxSchemaDepth}`);
        return;
    }
    if (typeof(schema) === "boolean") {
        if (!schema) {
            problems.push(`${at} does not accept any value`);
        }
        return;
    }
    if (!isPlainObject(schema)) {
        problems.push(`${at}: schema must be an object or a boolean`);
        return;
    }

    const keywords: string[] = Object.keys(schema);
    for (let index: number = 0; index < keywords.length; index += 1) {
        const keyword: string = keywords[index];
        if (!SupportedKeywords.includes(keyword) && !AnnotationKeywords.includes(keyword)) {
            problems.push(`${at}: unsupported keyword "${keyword}"`);
        }
    }

    /*
     * `pattern` and `format` are validated on the schema itself, not only when
     * the value happens to be a string, so a broken keyword cannot hide behind
     * a value of another type.
     */
    let patternRegExp: RegExp | undefined = (void 0);
    let patternSource: string | undefined = (void 0);
    if (Object.hasOwn(schema, "pattern")) {
        const declared: unknown = schema.pattern;
        if (typeof(declared) !== "string") {
            problems.push(`${at}: "pattern" must be a string`);
        } else {
            patternSource = declared;
            try {
                patternRegExp = new RegExp(declared);
            } catch {
                problems.push(`${at}: invalid pattern ${JSON.stringify(declared)}`);
            }
        }
    }
    let formatName: string | undefined = (void 0);
    if (Object.hasOwn(schema, "format")) {
        const declared: unknown = schema.format;
        if (typeof(declared) !== "string") {
            problems.push(`${at}: "format" must be a string`);
        } else if (!SupportedFormats.includes(declared)) {
            problems.push(`${at}: unsupported format "${declared}"`);
        } else {
            formatName = declared;
        }
    }

    if (Object.hasOwn(schema, "$ref")) {
        const ref: string | undefined = readString(schema, "$ref", at, problems);
        if (ref !== (void 0)) {
            const resolved: unknown = resolveRef(ref, root, at, problems);
            if (resolved !== (void 0)) {
                checkSchema(resolved, value, at, depth + 1, root, problems);
            }
        }
    }

    if (Object.hasOwn(schema, "const")) {
        const constValue: unknown = schema.const;
        const constProblem: string | undefined = jsonValueProblem(constValue, `${at}.const`);
        if (constProblem !== (void 0)) {
            problems.push(`${at}: "const" is not JSON (${constProblem})`);
        } else if (!sameJson(constValue, value)) {
            problems.push(`${at} must equal the const value`);
        }
    }

    const allowedValues: unknown[] | undefined = readEnum(schema, at, problems);
    if (allowedValues !== (void 0) && !allowedValues.some((item: unknown): boolean => sameJson(item, value))) {
        problems.push(`${at} is not one of the allowed values`);
    }

    const allOf: unknown[] | undefined = readSchemaArray(schema, "allOf", at, problems);
    if (allOf !== (void 0)) {
        for (let index: number = 0; index < allOf.length; index += 1) {
            checkSchema(allOf[index], value, at, depth + 1, root, problems);
        }
    }

    const anyOf: unknown[] | undefined = readSchemaArray(schema, "anyOf", at, problems);
    if (anyOf !== (void 0)) {
        let matched: boolean = false;
        for (let index: number = 0; index < anyOf.length; index += 1) {
            if (schemaMatches(anyOf[index], value, depth + 1, root)) {
                matched = true;
            }
        }
        if (!matched) {
            problems.push(`${at} matches none of anyOf`);
        }
    }

    const oneOf: unknown[] | undefined = readSchemaArray(schema, "oneOf", at, problems);
    if (oneOf !== (void 0)) {
        let matched: number = 0;
        for (let index: number = 0; index < oneOf.length; index += 1) {
            if (schemaMatches(oneOf[index], value, depth + 1, root)) {
                matched += 1;
            }
        }
        if (matched !== 1) {
            problems.push(`${at} matches ${matched} of oneOf, expected exactly 1`);
        }
    }

    if (Object.hasOwn(schema, "type")) {
        const types: string[] | undefined = readTypes(schema, at, problems);
        if (types !== (void 0) && !types.some((type: string): boolean => matchesType(type, value))) {
            problems.push(`${at} expected ${types.join("|")}`);
            return;
        }
    }

    if (Array.isArray(value)) {
        checkArrayKeywords(schema, value, at, depth, root, problems);
        return;
    }
    if (isPlainObject(value)) {
        checkObjectKeywords(schema, value, at, depth, root, problems);
        return;
    }
    if (typeof(value) === "string") {
        checkStringKeywords(schema, value, at, problems, patternRegExp, patternSource, formatName);
        return;
    }
    if (typeof(value) === "number") {
        checkNumberKeywords(schema, value, at, depth, root, problems);
    }
};

/**
 * Parse a tool call's arguments against its declared schema.
 *
 * The returned `args` is a deep-frozen clone of `raw`: mutating the caller's
 * object afterwards changes neither `args` nor `digest`.
 *
 * @throws BoundaryRejection `invalid_tool_args` with every problem found.
 */
const parseToolCallInner: (tool: ToolSchema, raw: unknown) => ParsedToolCall = (tool: ToolSchema, raw: unknown): ParsedToolCall => {
    const problems: string[] = [];
    let name: string = "";
    let schemaValue: unknown = (void 0);
    let schemaUsable: boolean = false;
    let rawObject: Record<string, unknown> | undefined = (void 0);

    const candidate: unknown = tool;
    if (!isPlainObject(candidate)) {
        problems.push("tool must be an object with a name and an inputSchema");
    } else {
        try {
            const declaredName: unknown = candidate.name;
            if (typeof(declaredName) !== "string" || declaredName.length === 0) {
                problems.push("tool.name must be a non-empty string");
            } else {
                name = declaredName;
            }
            if (!Object.hasOwn(candidate, "inputSchema")) {
                problems.push("tool.inputSchema is required (object or boolean)");
            } else {
                const declaredSchema: unknown = candidate.inputSchema;
                if (typeof(declaredSchema) === "boolean" || isPlainObject(declaredSchema)) {
                    schemaValue = declaredSchema;
                    schemaUsable = true;
                } else {
                    problems.push("tool.inputSchema must be an object or a boolean");
                }
            }
        } catch (error: unknown) {
            problems.push(`tool cannot be inspected (${error instanceof Error ? error.name : typeof(error)})`);
        }
    }

    if (!isPlainObject(raw)) {
        problems.push("arguments must be an object");
    } else {
        let jsonProblem: string | undefined = (void 0);
        try {
            jsonProblem = jsonValueProblem(raw);
        } catch (error: unknown) {
            jsonProblem = `arguments cannot be inspected (${error instanceof Error ? error.name : typeof(error)})`;
        }
        if (jsonProblem !== (void 0)) {
            problems.push(jsonProblem);
        } else {
            rawObject = raw;
        }
    }

    if (schemaUsable && rawObject !== (void 0)) {
        try {
            checkSchema(schemaValue, rawObject, "$", 0, schemaValue, problems);
        } catch (error: unknown) {
            problems.push(`arguments cannot be validated (${error instanceof Error ? error.name : typeof(error)})`);
        }
    }

    if (problems.length > 0) {
        throw new BoundaryRejection("invalid_tool_args", problems);
    }

    const accepted: Record<string, unknown> | undefined = rawObject;
    if (accepted === (void 0)) {
        throw new BoundaryRejection("invalid_tool_args", ["arguments must be an object"]);
    }

    try {
        const args: Record<string, unknown> = deepFreezeJson(cloneJson(accepted));
        return { tool: name, args, digest: digestOf(args) };
    } catch (error: unknown) {
        const reason: string = error instanceof Error ? error.message : String(error);
        throw new BoundaryRejection("invalid_tool_args", [`arguments are not strict JSON: ${reason}`]);
    }
};

/**
 * Public entry point. The inner checks catch the common inspection failures;
 * this outer guard covers a revoked `Proxy` whose very prototype lookup throws
 * before the inner `try` blocks run.
 */
export const parseToolCall: (tool: ToolSchema, raw: unknown) => ParsedToolCall = (tool: ToolSchema, raw: unknown): ParsedToolCall => {
    try {
        return parseToolCallInner(tool, raw);
    } catch (error: unknown) {
        if (error instanceof BoundaryRejection) {
            throw error;
        }
        const reason: string = error instanceof Error ? error.message : typeof(error);
        throw new BoundaryRejection("invalid_tool_args", [`arguments could not be inspected: ${reason}`]);
    }
};
