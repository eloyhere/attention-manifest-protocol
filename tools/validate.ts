#!/usr/bin/env node
/**
 * AMP schema validator.
 *
 * A deliberately small JSON Schema (draft 2020-12 subset) checker so that
 * `docs/schemas/*.json` are executable contracts, not decoration.
 *
 * Supported keywords: $ref (internal + relative file), type, const, enum,
 * required, properties, additionalProperties, items, additionalItems,
 * minItems, maxItems, uniqueItems, minLength, maxLength, pattern,
 * format (date-time), minimum, maximum, exclusiveMinimum, exclusiveMaximum,
 * minProperties, maxProperties, oneOf, anyOf, allOf.
 *
 * Keywords outside this subset are annotations and are ignored, as draft
 * 2020-12 requires. `$ref` is never exclusive: sibling keywords stay in force.
 * `date-time` is delegated to `src/semantic/time.ts` so the schema contract and
 * the construction boundary share exactly one RFC 3339 grammar.
 *
 * Usage: node tools/validate.ts [--quiet]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isDateTime } from "../src/semantic/time.ts";

const root: string = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir: string = join(root, "docs", "schemas");
const examplesDir: string = join(root, "docs", "examples");
const MAX_SCHEMA_DEPTH: number = 80;

const isObject = (v: any): boolean => v !== null && typeof(v) === "object" && !Array.isArray(v);
const typeOf = (v: any): string => (Array.isArray(v) ? "array" : v === null ? "null" : typeof(v));

const cache: Map<string, any> = new Map();

function load(absPath: string): any {
    if (cache.has(absPath)) {
        return cache.get(absPath);
    }
    const json: any = JSON.parse(readFileSync(absPath, "utf8"));
    cache.set(absPath, json);
    return json;
}

function resolveRef(ref: string, baseFile: string): { node: any; file: string } {
    const [filePart, pointerPart] = ref.split("#");
    const targetFile: string = filePart ? resolve(dirname(baseFile), filePart) : baseFile;
    const target: any = load(targetFile);
    let node: any = target;
    if (pointerPart) {
        const parts: string[] = pointerPart
            .split("/")
            .filter(Boolean)
            .map((p: string) => decodeURIComponent(p).replace(/~1/g, "/").replace(/~0/g, "~"));
        for (const p of parts) {
            // JSON pointers address own members only: inherited names such as
            // `constructor` must not resolve to Object.prototype values.
            node = (isObject(node) || Array.isArray(node)) && Object.hasOwn(node, p) ? node[p] : (void 0);
        }
    }
    return { node, file: targetFile };
}

/**
 * Shape gate only: `isDateTime` (from `src/semantic/time.ts`) adds calendar and
 * offset range checks and is the single authority for the `date-time` format.
 */
const DATE_TIME: RegExp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const KNOWN_TYPES: ReadonlySet<string> = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/**
 * Reject `type` values outside the supported set before evaluating them.
 *
 * @param declared raw `type` keyword
 * @param path instance path for messages
 * @param errors collected errors
 * @returns true when the keyword is usable
 */
function checkTypeKeyword(declared: any, path: string, errors: string[]): boolean {
    const values: any[] = Array.isArray(declared) ? declared : [declared];
    if (values.length === 0) {
        errors.push(`${path}: schema type "[]" is not supported`);
        return false;
    }
    for (const value of values) {
        if (typeof(value) !== "string" || !KNOWN_TYPES.has(value)) {
            const label: string = typeof(value) === "string" ? value : String(JSON.stringify(value));
            errors.push(`${path}: schema type "${label}" is not supported`);
            return false;
        }
    }
    return true;
}

function checkType(expected: any, data: any): boolean {
    if (Array.isArray(expected)) {
        return expected.some((t: any) => checkType(t, data));
    }
    switch (expected) {
        case "object":
            return isObject(data);
        case "array":
            return Array.isArray(data);
        case "string":
            return typeof(data) === "string";
        case "number":
            return typeof(data) === "number" && Number.isFinite(data);
        case "integer":
            return typeof(data) === "number" && Number.isInteger(data);
        case "boolean":
            return typeof(data) === "boolean";
        case "null":
            return data === null;
        default:
            return false;
    }
}

/**
 * Validate `data` against one schema node.
 *
 * @param schema schema node (object or boolean)
 * @param data instance value
 * @param baseFile absolute path of the schema file owning `schema`
 * @param path JSON pointer-ish instance path for messages
 * @param errors collected errors
 * @param depth schema recursion depth
 */
function validate(schema: any, data: any, baseFile: string, path: string, errors: string[], depth: number = 0): void {
    if (depth > MAX_SCHEMA_DEPTH) {
        errors.push(`${path}: max schema depth exceeded`);
        return;
    }
    if (schema === true) {
        return;
    }
    if (schema === false) {
        errors.push(`${path}: schema is false`);
        return;
    }
    if (schema === null || typeof(schema) !== "object" || Array.isArray(schema)) {
        errors.push(`${path}: schema must be an object or boolean`);
        return;
    }

    if (schema.$ref !== (void 0)) {
        const ref: string = String(schema.$ref);
        let resolved: { node: any; file: string } | null = null;
        try {
            resolved = resolveRef(schema.$ref, baseFile);
        } catch {
            errors.push(`${path}: unresolved $ref ${ref}`);
        }
        if (resolved !== null) {
            if (resolved.node === (void 0)) {
                errors.push(`${path}: unresolved $ref ${ref}`);
            } else {
                validate(resolved.node, data, resolved.file, path, errors, depth + 1);
            }
        }
        // No return: keywords declared next to $ref remain in force in 2020-12.
    }

    if (Array.isArray(schema.oneOf)) {
        const branchErrors: string[][] = [];
        let matched: number = 0;
        for (const branch of schema.oneOf) {
            const errs: string[] = [];
            validate(branch, data, baseFile, path, errs, depth + 1);
            if (errs.length === 0) {
                matched++;
            } else {
                branchErrors.push(errs);
            }
        }
        if (matched === 0) {
            const shortest: string[] = branchErrors.sort((a, b) => a.length - b.length)[0] ?? [];
            errors.push(`${path}: does not match any oneOf branch`);
            for (const e of shortest.slice(0, 4)) {
                errors.push(`  ${e}`);
            }
        } else if (matched > 1) {
            errors.push(`${path}: matches ${matched} oneOf branches (must be exactly one)`);
        }
        // No return: keywords declared next to oneOf remain in force.
    }

    if (Array.isArray(schema.anyOf)) {
        const ok: boolean = schema.anyOf.some((branch: any) => {
            const errs: string[] = [];
            validate(branch, data, baseFile, path, errs, depth + 1);
            return errs.length === 0;
        });
        if (!ok) {
            errors.push(`${path}: does not match any anyOf branch`);
        }
        // No return: keywords declared next to anyOf remain in force.
    }

    if (Array.isArray(schema.allOf)) {
        for (const branch of schema.allOf) {
            validate(branch, data, baseFile, path, errors, depth + 1);
        }
        // No return: keywords declared next to allOf remain in force.
    }

    if (Object.prototype.hasOwnProperty.call(schema, "const") && data !== schema.const) {
        errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(data)) {
        errors.push(`${path}: ${JSON.stringify(data)} is not in enum [${schema.enum.join(", ")}]`);
    }
    if (schema.type !== (void 0)) {
        if (!checkTypeKeyword(schema.type, path, errors)) {
            return;
        }
        if (!checkType(schema.type, data)) {
            errors.push(`${path}: expected ${schema.type}, got ${typeOf(data)}`);
            return;
        }
    }

    if (typeof(data) === "number") {
        if (schema.minimum !== (void 0) && data < schema.minimum) {
            errors.push(`${path}: ${data} < minimum ${schema.minimum}`);
        }
        if (schema.maximum !== (void 0) && data > schema.maximum) {
            errors.push(`${path}: ${data} > maximum ${schema.maximum}`);
        }
        if (typeof(schema.exclusiveMinimum) === "number" && data <= schema.exclusiveMinimum) {
            errors.push(`${path}: ${data} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
        } else if (schema.exclusiveMinimum === true && schema.minimum !== (void 0) && data <= schema.minimum) {
            errors.push(`${path}: ${data} <= exclusiveMinimum ${schema.minimum}`);
        }
        if (typeof(schema.exclusiveMaximum) === "number" && data >= schema.exclusiveMaximum) {
            errors.push(`${path}: ${data} >= exclusiveMaximum ${schema.exclusiveMaximum}`);
        } else if (schema.exclusiveMaximum === true && schema.maximum !== (void 0) && data >= schema.maximum) {
            errors.push(`${path}: ${data} >= exclusiveMaximum ${schema.maximum}`);
        }
    }

    if (typeof(data) === "string") {
        // Length is measured in Unicode code points, not UTF-16 code units.
        const length: number = [...data].length;
        if (schema.minLength !== (void 0) && length < schema.minLength) {
            errors.push(`${path}: too short (minLength ${schema.minLength})`);
        }
        if (schema.maxLength !== (void 0) && length > schema.maxLength) {
            errors.push(`${path}: too long (maxLength ${schema.maxLength})`);
        }
        if (typeof(schema.pattern) === "string") {
            let compiled: RegExp | null = null;
            try {
                compiled = new RegExp(schema.pattern);
            } catch {
                errors.push(`${path}: invalid pattern ${schema.pattern}`);
            }
            if (compiled !== null && !compiled.test(data)) {
                errors.push(`${path}: does not match pattern ${schema.pattern}`);
            }
        }
        if (schema.format === "date-time" && !(DATE_TIME.test(data) && isDateTime(data))) {
            errors.push(`${path}: invalid date-time ${data}`);
        }
    }

    if (Array.isArray(data)) {
        if (schema.minItems !== (void 0) && data.length < schema.minItems) {
            errors.push(`${path}: needs at least ${schema.minItems} items`);
        }
        if (schema.maxItems !== (void 0) && data.length > schema.maxItems) {
            errors.push(`${path}: allows at most ${schema.maxItems} items`);
        }
        if (Array.isArray(schema.items)) {
            const tuple: any[] = schema.items;
            data.forEach((item: any, index: number) => {
                if (index < tuple.length) {
                    validate(tuple[index], item, baseFile, `${path}[${index}]`, errors, depth + 1);
                } else if (schema.additionalItems === false) {
                    errors.push(`${path}[${index}]: additional item not allowed`);
                } else if (isObject(schema.additionalItems)) {
                    validate(schema.additionalItems, item, baseFile, `${path}[${index}]`, errors, depth + 1);
                }
            });
        } else if (schema.items !== (void 0)) {
            data.forEach((item: any, index: number) => validate(schema.items, item, baseFile, `${path}[${index}]`, errors, depth + 1));
        }
        if (schema.uniqueItems === true) {
            const seen: Set<string> = new Set();
            data.forEach((item: any, index: number) => {
                const key: string = JSON.stringify(item);
                if (seen.has(key)) {
                    errors.push(`${path}[${index}]: duplicate item (uniqueItems)`);
                } else {
                    seen.add(key);
                }
            });
        }
        return;
    }

    if (isObject(data)) {
        if (Array.isArray(schema.required)) {
            for (const key of schema.required) {
                if (!Object.prototype.hasOwnProperty.call(data, key)) {
                    errors.push(`${path}: missing required "${key}"`);
                }
            }
        }
        const props: any = isObject(schema.properties) ? schema.properties : {};
        for (const [key, value] of Object.entries(data)) {
            // Own properties only: `toString`, `constructor`, `valueOf` and
            // `__proto__` must not pass as declared properties.
            if (Object.hasOwn(props, key)) {
                validate(props[key], value, baseFile, `${path}.${key}`, errors, depth + 1);
            } else if (schema.additionalProperties === false) {
                errors.push(`${path}: unexpected property "${key}"`);
            } else if (isObject(schema.additionalProperties)) {
                validate(schema.additionalProperties, value, baseFile, `${path}.${key}`, errors, depth + 1);
            }
        }
        const propertyCount: number = Object.keys(data).length;
        if (schema.minProperties !== (void 0) && propertyCount < schema.minProperties) {
            errors.push(`${path}: needs at least ${schema.minProperties} properties`);
        }
        if (schema.maxProperties !== (void 0) && propertyCount > schema.maxProperties) {
            errors.push(`${path}: allows at most ${schema.maxProperties} properties`);
        }
    }
}

const KIND_TO_SCHEMA = {
    manifest: "manifest.schema.json",
    frame: "frame.schema.json",
    claim: "epistemic.schema.json",
    hypothesis: "epistemic.schema.json",
    unknown: "epistemic.schema.json",
    concept: "concept.schema.json",
    goal: "plan.schema.json",
    process: "plan.schema.json",
    plan: "plan.schema.json",
    "other-model": "social.schema.json",
    "common-ground": "social.schema.json",
    "attention-request": "social.schema.json",
    receipt: "receipt.schema.json",
    event: "receipt.schema.json",
    message: "message.schema.json",
    call: "verb.schema.json",
    bundle: "federation.schema.json",
    attestation: "federation.schema.json",
    "ledger-snapshot": "ledger-snapshot.schema.json",
    checkpoint: "compaction.schema.json",
    "prune-plan": "compaction.schema.json",
    "concept-prune-plan": "concept-compaction.schema.json",
    "concept-checkpoint": "concept-compaction.schema.json",
    delegation: "collaboration.schema.json",
    lease: "collaboration.schema.json",
    "result-contract": "collaboration.schema.json",
    "team-manifest": "team.schema.json",
    "commitment-record": "team.schema.json",
    "responsibility-assignment": "responsibility.schema.json",
    "interaction-binding": "interaction.schema.json",
    // governance.schema.json is not present in this snapshot; do not map
    // governance kinds to a missing contract.
};

function fail(msg: string): void {
    console.error(`\x1b[31m✗\x1b[0m ${msg}`);
    process.exitCode = 1;
}

function main(): void {
    if (!existsSync(schemaDir)) {
        return fail(`missing schema directory: ${schemaDir}`);
    }

    // 1. every schema must parse
    for (const file of readdirSync(schemaDir).filter((f: string) => f.endsWith(".json"))) {
        try {
            load(join(schemaDir, file));
        } catch (err) {
            fail(`schema ${file} is not valid JSON: ${err.message}`);
        }
    }

    if (!existsSync(examplesDir)) {
        console.log("no examples directory; schemas parsed only");
        return;
    }

    // 2. every example must validate against the schema for its kind
    let checked: number = 0;
    for (const file of readdirSync(examplesDir)
        .filter((f: string) => f.endsWith(".json"))
        .sort()) {
        const abs: string = join(examplesDir, file);
        let doc: any;
        try {
            doc = JSON.parse(readFileSync(abs, "utf8"));
        } catch (err) {
            fail(`${file}: invalid JSON (${err.message})`);
            continue;
        }

        const items = Array.isArray(doc) ? doc : [doc];
        items.forEach((item: any, index: number) => {
            const label: string = Array.isArray(doc) ? `${file}[${index}]` : file;
            const kind: any = item?.kind;
            const schemaName: string = KIND_TO_SCHEMA[kind];
            if (!schemaName) {
                fail(`${label}: unknown kind ${JSON.stringify(kind)}`);
                return;
            }
            const schemaPath: string = join(schemaDir, schemaName);
            let schema: any;
            try {
                schema = load(schemaPath);
            } catch (err) {
                fail(`${label}: cannot load ${schemaName} (${err.message})`);
                return;
            }
            const errors: string[] = [];
            validate(schema, item, schemaPath, "$", errors);
            if (errors.length) {
                fail(`${label} (${schemaName})`);
                for (const e of errors.slice(0, 12)) {
                    console.error(`    ${e}`);
                }
                if (errors.length > 12) {
                    console.error(`    … ${errors.length - 12} more`);
                }
            } else {
                checked++;
                console.log(`\x1b[32m✓\x1b[0m ${label}  (${schemaName})`);
            }
        });
    }

    console.log(`\n${checked} example object(s) validated`);
}

main();
