import type { JsonValue } from "../shared.ts";
import { immutableSnapshot } from "./immutable.ts";
import type { IntegrityCheckOptions, Invocation, Observation, ReceiptCore, ReceiptIntegrityVerification } from "./types.ts";

function validTimestamp(value: string): boolean {
    return Number.isFinite(Date.parse(value));
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

export function createReceiptCore(input: Omit<ReceiptCore, "invocation" | "observation"> & { readonly invocation: Invocation; readonly observation: Observation }): ReceiptCore {
    if (!input.id || !input.payloadDigest || !input.hashAlgorithm) throw new TypeError("Receipt identity, payload digest and hash algorithm are required");
    const context = input.invocation.context;
    if (!context.tenantId || !context.principalId || !context.agentId || !context.sessionId || !context.operationId || !context.attemptId || !context.executionId) throw new TypeError("Receipt execution identity is incomplete");
    if (input.observation.invocationId !== input.invocation.id) throw new TypeError("Receipt observation must reference its invocation");
    if (!validTimestamp(input.issuedAt)) throw new TypeError("Receipt issuedAt must be an ISO-compatible timestamp");
    return immutableSnapshot(input as unknown as JsonValue) as unknown as ReceiptCore;
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
