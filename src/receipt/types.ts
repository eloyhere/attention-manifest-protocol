import type { ExecutionContext, Identifier, JsonValue } from "../shared.ts";

export interface Invocation {
    readonly id: Identifier;
    readonly context: Readonly<ExecutionContext>;
    readonly toolId: Identifier;
    readonly arguments: JsonValue;
    readonly createdAt: string;
    readonly idempotencyKey?: string;
}

/**
 * Measured outcome costs attached to an observation (refract.md §9.1).
 * Every value is optional: a receipt captured without telemetry still
 * aggregates, and omitted costs count as zero samples rather than zero cost.
 */
export interface ObservationMetrics {
    /** Wall-clock execution time in milliseconds. */
    readonly durationMs?: number;
    /** Token cost of the observed execution. */
    readonly tokens?: number;
    /** Named resource consumptions, for example `{ calls: 3, bytes: 4096 }`. */
    readonly resources?: Readonly<Record<string, number>>;
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
    /** Measured duration, token and resource costs used by receipt aggregation. */
    readonly metrics?: ObservationMetrics;
}

/** Receipt kinds from the receipt taxonomy (refract.md §9.2). */
export const RECEIPT_KINDS = [
    "action_receipt",
    "task_receipt",
    "plan_receipt",
    "mission_receipt",
    "capability_receipt",
    "profession_switch_receipt",
    "delegation_receipt",
    "merge_receipt",
    "cooperation_receipt",
    "arbitration_receipt",
    "session_receipt",
    "turn_receipt",
    "session_resume_receipt",
    "turn_resume_receipt",
    "file_mount_receipt",
    "file_flush_receipt",
    "file_unmount_receipt",
] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

/** Receipt lifecycle states (refract.md §9.3). */
export const RECEIPT_LIFECYCLES = [
    "issued",
    "signed",
    "anchored",
    "verified",
    "archived",
    "disputed",
    "revoked",
    "purged",
] as const;
export type ReceiptLifecycle = (typeof RECEIPT_LIFECYCLES)[number];

/** Workspace coordinates a receipt can be rolled back to. */
export interface WorkspaceAnchor {
    readonly workspaceId: Identifier;
    readonly snapshotId?: Identifier;
    readonly changeHash?: string;
    readonly affectedFiles?: readonly string[];
    readonly affectedSymbols?: readonly string[];
}

/** A precise capability version cited by the executor description. */
export interface ExecutorVersion {
    readonly id: Identifier;
    readonly version: string;
}

/** Versioned executor profile: who (profession) and with which capabilities. */
export interface ExecutorProfile {
    readonly professionId?: Identifier;
    readonly skill?: ExecutorVersion;
    readonly tool?: ExecutorVersion;
    readonly cognition?: ExecutorVersion;
    readonly protocol?: ExecutorVersion;
    readonly behavior?: readonly ExecutorVersion[];
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
    /** Receipt taxonomy member; omitted for legacy action receipts. */
    readonly kind?: ReceiptKind;
    readonly parentId?: Identifier;
    readonly agentId?: Identifier;
    readonly sessionId?: Identifier;
    readonly turnId?: Identifier;
    /** Primary capability the action exercised; used by capability evaluation. */
    readonly capabilityId?: Identifier;
    /** Workspace snapshot and change coordinates for rollback. */
    readonly workspaceAnchor?: WorkspaceAnchor;
    readonly executor?: ExecutorProfile;
    readonly evidenceIds?: readonly Identifier[];
    /**
     * Lifecycle state. Construction defaults an omitted value to `issued`;
     * stored receipts can only move along {@link receiptLifecycle}.
     */
    readonly lifecycle?: ReceiptLifecycle;
}

/** Conceptual receipt record; interchangeable with {@link ReceiptCore}. */
export type Receipt = ReceiptCore;

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

const RECEIPT_LIFECYCLE_EDGES: Record<ReceiptLifecycle, readonly ReceiptLifecycle[]> = {
    issued: ["signed", "disputed", "revoked"],
    signed: ["anchored", "disputed", "revoked"],
    anchored: ["verified", "disputed", "revoked"],
    verified: ["archived", "disputed", "revoked"],
    archived: ["purged", "disputed"],
    disputed: ["verified", "revoked", "archived"],
    revoked: ["purged"],
    purged: [],
};

/**
 * Local receipt lifecycle edges. Issuing is implicit at construction; signing,
 * anchoring and verification are separate facts recorded by later transitions.
 */
export const receiptLifecycle: Readonly<Record<ReceiptLifecycle, readonly ReceiptLifecycle[]>> = Object.freeze(
    Object.fromEntries(
        Object.entries(RECEIPT_LIFECYCLE_EDGES).map(([state, next]) => [state, Object.freeze([...next])]),
    ) as Record<ReceiptLifecycle, readonly ReceiptLifecycle[]>,
);

/** Alias with an explicit table-shaped name, mirroring `EVIDENCE_TRANSITIONS`. */
export const RECEIPT_TRANSITIONS: Readonly<Record<ReceiptLifecycle, readonly ReceiptLifecycle[]>> = receiptLifecycle;

export function isReceiptKind(value: unknown): value is ReceiptKind {
    return typeof value === "string" && (RECEIPT_KINDS as readonly string[]).includes(value);
}

export function isReceiptLifecycle(value: unknown): value is ReceiptLifecycle {
    return typeof value === "string" && (RECEIPT_LIFECYCLES as readonly string[]).includes(value);
}
