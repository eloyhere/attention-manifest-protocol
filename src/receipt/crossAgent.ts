import type { Identifier } from "../shared.ts";
import type { ReceiptCore } from "./types.ts";
import { RECEIPT_LIFECYCLES } from "./types.ts";

/** Default minimum trust for accepting a receipt authored by another agent. */
export const DEFAULT_FOREIGN_RECEIPT_TRUST = 0.5 as const;

/**
 * Verification view supplied by the receiving agent. `trustLevel` is the
 * verifier's trust in the receipt's signing agent (0..1); `knownEvidenceIds`
 * and the callbacks are optional because a verifier may not hold the peer's
 * evidence ledger or signing keys.
 */
export interface ForeignReceiptVerifier {
    readonly verifierId?: Identifier;
    /** Trust in the signer agent, in 0..1. */
    readonly trustLevel: number;
    /** Minimum trust required; defaults to {@link DEFAULT_FOREIGN_RECEIPT_TRUST}. */
    readonly minimumTrustLevel?: number;
    /** Evidence identifiers this verifier can resolve; unresolved references are rejected. */
    readonly knownEvidenceIds?: readonly Identifier[];
    /** Cryptographic signature check. Presence is checked even when omitted. */
    readonly verifySignature?: (receipt: ReceiptCore) => boolean;
    /** Recomputes the payload digest; the stored digest is accepted when omitted. */
    readonly digest?: (receipt: ReceiptCore) => string;
    /** Workspace the verifier expects the anchor to address. */
    readonly expectedWorkspaceId?: Identifier;
    /** Agent the verifier expects to have authored the receipt. */
    readonly expectedAgentId?: Identifier;
}

/** Result of cross-agent receipt verification (refract.md §9.6). */
export interface ForeignReceiptVerification {
    readonly accepted: boolean;
    /** Stable rejection reasons; empty when accepted. */
    readonly reasons: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function pushUnique(reasons: string[], reason: string): void {
    if (!reasons.includes(reason)) reasons.push(reason);
}

function validateVerifier(verifier: ForeignReceiptVerifier): void {
    if (!isRecord(verifier)) throw new TypeError("Foreign receipt verifier must be an object");
    if (verifier.verifierId !== undefined && !isNonEmptyString(verifier.verifierId)) throw new TypeError("Foreign receipt verifierId must be a non-empty identifier");
    if (verifier.minimumTrustLevel !== undefined && (!Number.isFinite(verifier.minimumTrustLevel) || verifier.minimumTrustLevel < 0 || verifier.minimumTrustLevel > 1)) {
        throw new TypeError("Foreign receipt minimumTrustLevel must be a finite number between 0 and 1");
    }
    if (verifier.knownEvidenceIds !== undefined) {
        if (!Array.isArray(verifier.knownEvidenceIds)) throw new TypeError("Foreign receipt knownEvidenceIds must be an array");
        for (const evidenceId of verifier.knownEvidenceIds) {
            if (!isNonEmptyString(evidenceId)) throw new TypeError("Foreign receipt knownEvidenceIds must contain non-empty identifiers");
        }
    }
    for (const callback of ["verifySignature", "digest"] as const) {
        if (verifier[callback] !== undefined && typeof verifier[callback] !== "function") {
            throw new TypeError(`Foreign receipt verifier ${callback} must be a function`);
        }
    }
    if (verifier.expectedWorkspaceId !== undefined && !isNonEmptyString(verifier.expectedWorkspaceId)) throw new TypeError("Foreign receipt expectedWorkspaceId must be a non-empty identifier");
    if (verifier.expectedAgentId !== undefined && !isNonEmptyString(verifier.expectedAgentId)) throw new TypeError("Foreign receipt expectedAgentId must be a non-empty identifier");
}

/**
 * Verifies a receipt authored by another agent (refract.md §9.6): signature and
 * signer identity, workspace anchor completeness, evidence references and agent
 * trust. A missing signature or anchor is always rejected with an explicit
 * reason. Deterministic checks never mutate the receipt, and the returned
 * result is frozen.
 *
 * The verifier supplies its own trust input. Invalid verifier configuration
 * (for example a non-numeric minimum threshold) is a programmer error and
 * throws `TypeError`; a missing or out-of-range trust level for the signer is a
 * verification rejection.
 */
export function verifyForeignReceipt(receipt: ReceiptCore, verifier: ForeignReceiptVerifier): ForeignReceiptVerification {
    if (!isRecord(receipt)) throw new TypeError("Foreign receipt must be an object");
    validateVerifier(verifier);

    const reasons: string[] = [];

    if (receipt.lifecycle !== undefined && !(RECEIPT_LIFECYCLES as readonly string[]).includes(receipt.lifecycle)) {
        pushUnique(reasons, "lifecycle_invalid");
    } else if (receipt.lifecycle === "revoked") {
        pushUnique(reasons, "receipt_revoked");
    } else if (receipt.lifecycle === "purged") {
        pushUnique(reasons, "receipt_purged");
    } else if (receipt.lifecycle === "disputed") {
        pushUnique(reasons, "receipt_disputed");
    }

    if (!isNonEmptyString(receipt.signature)) {
        pushUnique(reasons, "signature_missing");
    } else if (verifier.verifySignature !== undefined && verifier.verifySignature(receipt) !== true) {
        pushUnique(reasons, "signature_invalid");
    }
    if (!isNonEmptyString(receipt.signerKeyId)) pushUnique(reasons, "signer_missing");
    if (!isNonEmptyString(receipt.agentId)) pushUnique(reasons, "agent_missing");
    else if (verifier.expectedAgentId !== undefined && receipt.agentId !== verifier.expectedAgentId) pushUnique(reasons, "agent_mismatch");

    if (!isNonEmptyString(receipt.payloadDigest)) pushUnique(reasons, "payload_digest_missing");
    if (!isNonEmptyString(receipt.hashAlgorithm)) pushUnique(reasons, "hash_algorithm_missing");
    if (isNonEmptyString(receipt.payloadDigest) && verifier.digest !== undefined && verifier.digest(receipt) !== receipt.payloadDigest) {
        pushUnique(reasons, "payload_digest_mismatch");
    }

    const anchor = receipt.workspaceAnchor;
    if (anchor === undefined || anchor === null) {
        pushUnique(reasons, "anchor_missing");
    } else if (!isRecord(anchor)) {
        pushUnique(reasons, "anchor_invalid");
    } else {
        if (!isNonEmptyString(anchor.workspaceId)) pushUnique(reasons, "anchor_invalid");
        if (!isNonEmptyString(anchor.snapshotId) && !isNonEmptyString(anchor.changeHash)) pushUnique(reasons, "anchor_incomplete");
        if (verifier.expectedWorkspaceId !== undefined && anchor.workspaceId !== verifier.expectedWorkspaceId) pushUnique(reasons, "anchor_mismatch");
    }

    const evidenceIds = receipt.evidenceIds;
    if (evidenceIds === undefined || (Array.isArray(evidenceIds) && evidenceIds.length === 0)) {
        pushUnique(reasons, "evidence_missing");
    } else if (!Array.isArray(evidenceIds)) {
        pushUnique(reasons, "evidence_invalid");
    } else {
        const seen = new Set<string>();
        for (const evidenceId of evidenceIds) {
            if (!isNonEmptyString(evidenceId)) {
                pushUnique(reasons, "evidence_invalid");
                continue;
            }
            if (seen.has(evidenceId)) {
                pushUnique(reasons, "evidence_invalid");
                continue;
            }
            seen.add(evidenceId);
            if (verifier.knownEvidenceIds !== undefined && !verifier.knownEvidenceIds.includes(evidenceId)) {
                pushUnique(reasons, `evidence_unknown:${evidenceId}`);
            }
        }
    }

    const trustLevel = verifier.trustLevel;
    if (typeof trustLevel !== "number" || !Number.isFinite(trustLevel) || trustLevel < 0 || trustLevel > 1) {
        pushUnique(reasons, "trust_invalid");
    } else {
        const minimum = verifier.minimumTrustLevel ?? DEFAULT_FOREIGN_RECEIPT_TRUST;
        if (trustLevel < minimum) pushUnique(reasons, "trust_too_low");
    }

    return Object.freeze({
        accepted: reasons.length === 0,
        reasons: Object.freeze([...reasons]),
    });
}
