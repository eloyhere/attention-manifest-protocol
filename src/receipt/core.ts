import type { JsonValue } from "../shared.ts";
import { immutableSnapshot } from "./immutable.ts";
import type {
    IntegrityCheckOptions,
    Invocation,
    Observation,
    ReceiptCore,
    ReceiptIntegrityVerification,
    ReceiptLifecycle,
} from "./types.ts";
import { isReceiptKind, isReceiptLifecycle, receiptLifecycle } from "./types.ts";

type ReceiptInput = Omit<ReceiptCore, "invocation" | "observation"> & { readonly invocation: Invocation; readonly observation: Observation };

function validTimestamp(value: string): boolean {
    return Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function validateOptionalIdentifier(field: string, value: unknown): void {
    if (value !== undefined && !isNonEmptyString(value)) throw new TypeError(`Receipt ${field} must be a non-empty identifier`);
}

function validateStringArray(field: string, value: unknown): void {
    if (!Array.isArray(value)) throw new TypeError(`Receipt ${field} must be an array`);
    const seen = new Set<string>();
    for (const item of value) {
        if (!isNonEmptyString(item)) throw new TypeError(`Receipt ${field} must contain non-empty strings`);
        if (seen.has(item)) throw new TypeError(`Receipt ${field} contains duplicate value: ${item}`);
        seen.add(item);
    }
}

function validateWorkspaceAnchor(value: unknown): void {
    if (!isRecord(value)) throw new TypeError("Receipt workspaceAnchor must be an object");
    if (!isNonEmptyString(value.workspaceId)) throw new TypeError("Receipt workspaceAnchor requires a non-empty workspaceId");
    validateOptionalIdentifier("workspaceAnchor.snapshotId", value.snapshotId);
    validateOptionalIdentifier("workspaceAnchor.changeHash", value.changeHash);
    if (value.affectedFiles !== undefined) validateStringArray("workspaceAnchor.affectedFiles", value.affectedFiles);
    if (value.affectedSymbols !== undefined) validateStringArray("workspaceAnchor.affectedSymbols", value.affectedSymbols);
}

function validateExecutorVersion(field: string, value: unknown): void {
    if (!isRecord(value)) throw new TypeError(`Receipt ${field} must be an object`);
    if (!isNonEmptyString(value.id)) throw new TypeError(`Receipt ${field} requires a non-empty id`);
    if (!isNonEmptyString(value.version)) throw new TypeError(`Receipt ${field} requires a non-empty version`);
}

function validateExecutor(value: unknown): void {
    if (!isRecord(value)) throw new TypeError("Receipt executor must be an object");
    validateOptionalIdentifier("executor.professionId", value.professionId);
    for (const field of ["skill", "tool", "cognition", "protocol"] as const) {
        if (value[field] !== undefined) validateExecutorVersion(`executor.${field}`, value[field]);
    }
    if (value.behavior !== undefined) {
        if (!Array.isArray(value.behavior)) throw new TypeError("Receipt executor.behavior must be an array");
        for (const item of value.behavior) validateExecutorVersion("executor.behavior", item);
    }
}

function validateReceiptExtensions(input: ReceiptInput): void {
    if (input.kind !== undefined && !isReceiptKind(input.kind)) throw new TypeError(`invalid receipt kind: ${String(input.kind)}`);
    if (input.lifecycle !== undefined && !isReceiptLifecycle(input.lifecycle)) throw new TypeError(`invalid receipt lifecycle: ${String(input.lifecycle)}`);
    validateOptionalIdentifier("parentId", input.parentId);
    validateOptionalIdentifier("agentId", input.agentId);
    validateOptionalIdentifier("sessionId", input.sessionId);
    validateOptionalIdentifier("turnId", input.turnId);
    if (input.workspaceAnchor !== undefined) validateWorkspaceAnchor(input.workspaceAnchor);
    if (input.executor !== undefined) validateExecutor(input.executor);
    if (input.evidenceIds !== undefined) validateStringArray("evidenceIds", input.evidenceIds);
}

export function createInvocation(input: Invocation): Invocation {
    const context = input.context;
    if (!input.id || !input.toolId || !context.tenantId || !context.principalId || !context.agentId || !context.sessionId || !context.operationId || !context.attemptId || !context.executionId) throw new TypeError("Invocation identity and execution context are required");
    if (!validTimestamp(input.createdAt)) throw new TypeError("Invocation createdAt must be an ISO-compatible timestamp");
    return immutableSnapshot(input as unknown as JsonValue) as unknown as Invocation;
}

export function createObservation(input: Observation): Observation {
    if (!input.id || !input.invocationId) throw new TypeError("Observation and invocation identifiers are required");
    if (!validTimestamp(input.observedAt)) throw new TypeError("Observation observedAt must be an ISO-compatible timestamp");
    if (input.status === "success" && input.error !== undefined) throw new TypeError("Successful observation cannot contain an error");
    if (input.status === "failure" && !input.error) throw new TypeError("Failure observation must include an error");
    return immutableSnapshot(input as unknown as JsonValue) as unknown as Observation;
}

export function createReceiptCore(input: ReceiptInput): ReceiptCore {
    if (!input.id || !input.payloadDigest || !input.hashAlgorithm) throw new TypeError("Receipt identity, payload digest and hash algorithm are required");
    const context = input.invocation.context;
    if (!context.tenantId || !context.principalId || !context.agentId || !context.sessionId || !context.operationId || !context.attemptId || !context.executionId) throw new TypeError("Receipt execution identity is incomplete");
    if (input.observation.invocationId !== input.invocation.id) throw new TypeError("Receipt observation must reference its invocation");
    if (!validTimestamp(input.issuedAt)) throw new TypeError("Receipt issuedAt must be an ISO-compatible timestamp");
    validateReceiptExtensions(input);
    const lifecycle = input.lifecycle ?? "issued";
    return immutableSnapshot({ ...input, lifecycle } as unknown as JsonValue) as unknown as ReceiptCore;
}

function nextReceiptLifecycle(current: ReceiptLifecycle, next: ReceiptLifecycle): ReceiptLifecycle {
    if (!Object.hasOwn(receiptLifecycle, current)) throw new TypeError(`invalid receipt lifecycle: ${String(current)}`);
    if (!Object.hasOwn(receiptLifecycle, next)) throw new TypeError(`invalid receipt lifecycle: ${String(next)}`);
    if (!receiptLifecycle[current].includes(next)) throw new TypeError(`invalid receipt transition: ${current} -> ${next}`);
    return next;
}

/**
 * Advances a receipt along {@link receiptLifecycle} and returns a new frozen
 * receipt; the input receipt is never mutated. A bare lifecycle state may also
 * be advanced for callers that manage receipts externally.
 */
export function advanceReceipt(receipt: ReceiptCore, next: ReceiptLifecycle): ReceiptCore;
export function advanceReceipt(lifecycle: ReceiptLifecycle, next: ReceiptLifecycle): ReceiptLifecycle;
export function advanceReceipt(target: ReceiptCore | ReceiptLifecycle, next: ReceiptLifecycle): ReceiptCore | ReceiptLifecycle {
    if (typeof target === "string") return nextReceiptLifecycle(target, next);
    const current = target.lifecycle ?? "issued";
    nextReceiptLifecycle(current, next);
    return immutableSnapshot({ ...target, lifecycle: next } as unknown as JsonValue) as unknown as ReceiptCore;
}

export async function verifyReceiptIntegrity(receipt: ReceiptCore, options: IntegrityCheckOptions): Promise<ReceiptIntegrityVerification> {
    const [expected, signatureValid] = await Promise.all([
        options.digest(receipt),
        options.verifySignature ? options.verifySignature(receipt) : Promise.resolve<true | "not_checked">("not_checked"),
    ]);
    const digestValid = expected === receipt.payloadDigest;
    const signaturePresent = receipt.signature !== undefined;
    const signatureOk = signaturePresent ? signatureValid === true : signatureValid === "not_checked" || signatureValid === true;
    const reasons: string[] = [];
    if (!digestValid) reasons.push("payload_digest_mismatch");
    if (signaturePresent && signatureValid === "not_checked") reasons.push("signature_not_checked");
    if (signatureValid === false) reasons.push("signature_invalid");
    return Object.freeze({
        id: `integrity:${receipt.id}:${options.verifiedAt}`,
        receiptId: receipt.id,
        status: digestValid && signatureOk ? "integrity_verified" : "integrity_rejected",
        digestValid,
        signatureValid,
        verifier: options.verifier,
        verifiedAt: options.verifiedAt,
        reasons: Object.freeze(reasons),
    });
}
