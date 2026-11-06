import type { ExecutionContext, Identifier, JsonValue } from "../shared.ts";

export interface Invocation {
    readonly id: Identifier;
    readonly context: Readonly<ExecutionContext>;
    readonly toolId: Identifier;
    readonly arguments: JsonValue;
    readonly createdAt: string;
    readonly idempotencyKey?: string;
}

export interface Observation {
    readonly id: Identifier;
    readonly invocationId: Identifier;
    readonly status: "success" | "failure" | "unknown";
    readonly value?: JsonValue;
    readonly error?: string;
    readonly observedAt: string;
    readonly digest?: string;
    readonly externalEffectId?: Identifier;
    readonly artifactVersions?: readonly string[];
}

/** Immutable execution fact; verification is represented by separate records. */
export interface ReceiptCore {
    readonly id: Identifier;
    readonly invocation: Invocation;
    readonly observation: Observation;
    readonly issuedAt: string;
    readonly payloadDigest: string;
    readonly hashAlgorithm: string;
    readonly signature?: string;
    readonly signerKeyId?: string;
}

export interface ReceiptIntegrityVerification {
    readonly id: Identifier;
    readonly receiptId: Identifier;
    readonly status: "integrity_verified" | "integrity_rejected";
    readonly digestValid: boolean;
    readonly signatureValid: boolean | "not_checked";
    readonly verifier: string;
    readonly verifiedAt: string;
    readonly reasons: readonly string[];
}

export interface IntegrityCheckOptions {
    readonly digest: (receipt: ReceiptCore) => string | Promise<string>;
    readonly verifySignature?: (receipt: ReceiptCore) => boolean | Promise<boolean>;
    readonly verifier: string;
    readonly verifiedAt: string;
}
