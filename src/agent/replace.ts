import type { GatewayHandler } from "./gateway.ts";
import type { Workspace } from "../workspace/core.ts";
import type { WorkspaceFile } from "../file/core.ts";
import type { EditOptions, ReplaceMode, ReplaceTarget } from "../file/types.ts";
import { WorkspaceError } from "../workspace/types.ts";
import { createOutlineProvider } from "../file/outline.ts";

const MODES: readonly ReplaceMode[] = Object.freeze(["string", "regex", "line", "byte", "outline"]);
const PARAMETERS: readonly string[] = Object.freeze([
    "path", "mode", "replacement", "text", "pattern", "flags", "occurrence", "all",
    "start", "end", "id", "expectedBufferVersion", "expectedBaseHash",
]);

export interface ReplaceToolResult {
    readonly path: string;
    readonly mode: ReplaceMode;
    readonly state: string;
    readonly version: number;
    readonly bufferVersion: number;
    readonly dirty: boolean;
    readonly stale: boolean;
    readonly hash: string;
    readonly baseHash: string;
}

function fail(message: string): never {
    throw new TypeError(message);
}

function objectOf(parameters: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
        fail("replace parameters must be an object");
    }
    for (const key of Object.keys(parameters)) {
        if (!PARAMETERS.includes(key)) { fail(`unknown replace parameter: ${key}`); }
    }
    return parameters;
}

function requiredString(parameters: Readonly<Record<string, unknown>>, key: string): string {
    const value = parameters[key];
    if (typeof value !== "string" || !value.trim()) { fail(`${key} must be a nonempty string`); }
    return value;
}

function optionalString(parameters: Readonly<Record<string, unknown>>, key: string): string | undefined {
    const value = parameters[key];
    if (value === undefined) { return undefined; }
    if (typeof value !== "string" || !value.trim()) { fail(`${key} must be a nonempty string`); }
    return value;
}

function requiredCount(parameters: Readonly<Record<string, unknown>>, key: string): number {
    const value = parameters[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        fail(`${key} must be a nonnegative safe integer`);
    }
    return value;
}

function optionalCount(parameters: Readonly<Record<string, unknown>>, key: string): number | undefined {
    const value = parameters[key];
    if (value === undefined) { return undefined; }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        fail(`${key} must be a positive safe integer`);
    }
    return value;
}

function optionalBoolean(parameters: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
    const value = parameters[key];
    if (value === undefined) { return undefined; }
    if (typeof value !== "boolean") { fail(`${key} must be a boolean`); }
    return value;
}

function buildTarget(parameters: Readonly<Record<string, unknown>>, mode: ReplaceMode): ReplaceTarget {
    if (mode === "string") {
        return Object.freeze({ mode: "string", text: requiredString(parameters, "text"),
            ...(optionalCount(parameters, "occurrence") !== undefined ? { occurrence: optionalCount(parameters, "occurrence")! } : {}),
            ...(optionalBoolean(parameters, "all") !== undefined ? { all: optionalBoolean(parameters, "all")! } : {}) });
    }
    if (mode === "regex") {
        return Object.freeze({ mode: "regex", pattern: requiredString(parameters, "pattern"),
            ...(optionalString(parameters, "flags") !== undefined ? { flags: optionalString(parameters, "flags")! } : {}),
            ...(optionalCount(parameters, "occurrence") !== undefined ? { occurrence: optionalCount(parameters, "occurrence")! } : {}),
            ...(optionalBoolean(parameters, "all") !== undefined ? { all: optionalBoolean(parameters, "all")! } : {}) });
    }
    if (mode === "outline") {
        return Object.freeze({ mode: "outline", id: requiredString(parameters, "id") });
    }
    const start = requiredCount(parameters, "start");
    const end = requiredCount(parameters, "end");
    if (end < start) { fail("end must be greater than or equal to start"); }
    return Object.freeze({ mode, start, end });
}

/**
 * Builds the agent-callable replace handler. The host registers it under
 * `REPLACE_TOOL_NAME`; the gateway owns authorization and idempotency.
 * Parameters mirror the file replace API: string, regex, line, byte or
 * outline targets, plus optional compare-and-swap guards.
 */
export function createReplaceToolHandler(workspace: Workspace): GatewayHandler {
    return (rawParameters) => {
        const parameters = objectOf(rawParameters);
        const path = requiredString(parameters, "path");
        const mode = parameters.mode;
        if (typeof mode !== "string" || !MODES.includes(mode as ReplaceMode)) {
            fail(`mode must be one of ${MODES.join(", ")}`);
        }
        const replacement = parameters.replacement;
        if (typeof replacement !== "string") { fail("replacement must be a string"); }
        const target = buildTarget(parameters, mode as ReplaceMode);
        const edit: EditOptions = Object.freeze({
            ...(parameters.expectedBufferVersion !== undefined ? { expectedBufferVersion: requiredCount(parameters, "expectedBufferVersion") } : {}),
            ...(parameters.expectedBaseHash !== undefined ? { expectedBaseHash: requiredString(parameters, "expectedBaseHash") } : {}),
        });
        const mountOptions = { mode: "writable" as const, ...(mode === "outline" ? { outline: createOutlineProvider() } : {}) };
        // Mount owned by this call; reuse an existing mount instead of failing.
        let file: WorkspaceFile;
        let owned = false;
        try {
            file = workspace.mount(path, mountOptions);
            owned = true;
        } catch (error) {
            if (error instanceof WorkspaceError && error.code === "already_mounted") { file = workspace.file(path); }
            else { throw error; }
        }
        try {
            file.replace(target, replacement, edit);
            // A replace edits the buffer; the tool's contract is a durable change.
            const snapshot = file.flush();
            const result: ReplaceToolResult = Object.freeze({
                path: snapshot.path, mode: mode as ReplaceMode, state: snapshot.state,
                version: snapshot.version, bufferVersion: snapshot.bufferVersion,
                dirty: snapshot.dirty, stale: snapshot.stale, hash: snapshot.hash, baseHash: snapshot.baseHash,
            });
            return result;
        } finally {
            if (owned) {
                // The commit already happened; a failing unmount must not mask it.
                try { file.unmount(); } catch { /* keep the replace result */ }
            }
        }
    };
}
