import type { ReceiptCore, ReceiptIntegrityVerification } from "../receipt/types.ts";
import type { BusinessVerification, SemanticEvaluator, VerificationOptions } from "./types.ts";

export async function verifyBusinessSemantics(receipt: ReceiptCore, integrity: ReceiptIntegrityVerification, options: VerificationOptions, evaluate: SemanticEvaluator, claims: readonly string[]): Promise<BusinessVerification> {
    if (integrity.receiptId !== receipt.id || integrity.status !== "integrity_verified") {
        return Object.freeze({ id: options.id, observationId: receipt.observation.id, receiptId: receipt.id, status: "inconclusive", claims: Object.freeze([...claims]), criteriaVersion: options.criteriaVersion, verifier: options.verifier, verifiedAt: options.verifiedAt, rationale: "receipt_integrity_not_verified" });
    }
    const valid = await evaluate(receipt.observation, receipt);
    return Object.freeze({ id: options.id, observationId: receipt.observation.id, receiptId: receipt.id, status: valid ? "semantic_verified" : "semantic_rejected", claims: Object.freeze([...claims]), criteriaVersion: options.criteriaVersion, verifier: options.verifier, verifiedAt: options.verifiedAt });
}
