import type { Identifier } from "../shared.ts";
import type { ReceiptCore, ReceiptIntegrityVerification } from "../receipt/types.ts";
import type { BusinessVerification } from "../verification/types.ts";

export type EvidenceStatus = "active" | "revoked" | "stale" | "pending_revalidation";
export interface Evidence {
    readonly id: Identifier;
    readonly tenantId: Identifier;
    readonly dependsOn: readonly Identifier[];
    readonly claim: string;
    readonly polarity: "supports" | "refutes";
    readonly observationId: Identifier;
    readonly receiptId: Identifier;
    readonly verificationId: Identifier;
    readonly integrityVerificationId: Identifier;
    readonly criteriaVersion: string;
    readonly environmentVersion: string;
    readonly createdAt: string;
    readonly expiresAt?: string;
    readonly status: EvidenceStatus;
}

export type ProvenanceEvent =
    | { readonly type: "evidence_added"; readonly evidenceId: Identifier; readonly at: string }
    | { readonly type: "evidence_revoked" | "evidence_staled"; readonly evidenceId: Identifier; readonly reason: string; readonly at: string }
    | { readonly type: "dependency_invalidated"; readonly sourceId: Identifier; readonly dependentId: Identifier; readonly at: string };

export interface AddEvidenceInput {
    readonly id: Identifier;
    readonly tenantId: Identifier;
    readonly dependsOn?: readonly Identifier[];
    readonly claim: string;
    readonly polarity: "supports" | "refutes";
    readonly receipt: ReceiptCore;
    readonly integrity: ReceiptIntegrityVerification;
    readonly verification: BusinessVerification;
    readonly criteriaVersion: string;
    readonly environmentVersion: string;
    readonly createdAt: string;
    readonly expiresAt?: string;
}

export type EvidenceCause = { readonly kind: "evidence" | "receipt" | "observation" | "verification" | "environment"; readonly id: Identifier; readonly tenantId: Identifier };
