import type { Identifier } from "../shared.ts";
import type { Observation, ReceiptCore, ReceiptIntegrityVerification } from "../receipt/types.ts";

export interface BusinessVerification {
    readonly id: Identifier;
    readonly observationId: Identifier;
    readonly receiptId: Identifier;
    readonly status: "semantic_verified" | "semantic_rejected" | "inconclusive";
    readonly claims: readonly string[];
    readonly criteriaVersion: string;
    readonly verifier: string;
    readonly verifiedAt: string;
    readonly rationale?: string;
}

export interface VerificationOptions {
    readonly id: Identifier;
    readonly verifier: string;
    readonly verifiedAt: string;
    readonly criteriaVersion: string;
}

export type SemanticEvaluator = (observation: Observation, receipt: ReceiptCore) => boolean | Promise<boolean>;
export type { Observation, ReceiptCore, ReceiptIntegrityVerification };
