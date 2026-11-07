import { EVIDENCE_STATUSES } from "../evidence/types.ts";
import type { EvidenceStatus } from "../evidence/types.ts";
import type { Identifier, JsonValue } from "../shared.ts";
import { immutableSnapshot } from "./immutable.ts";
import type { ReceiptCore, WorkspaceAnchor } from "./types.ts";

/** Stable failure codes for rollback planning and application. */
export type RollbackErrorCode = "receipt_not_found" | "duplicate_receipt" | "invalid_plan" | "invalid_ports";

export class RollbackError extends Error {
    readonly code: RollbackErrorCode;

    constructor(code: RollbackErrorCode, message: string) {
        super(`${code}: ${message}`);
        this.name = "RollbackError";
        this.code = code;
    }
}

/**
 * The minimal evidence shape rollback planning needs. An `Evidence` record is
 * assignable directly; callers that only hold references can omit `status`, in
 * which case the evidence is planned for staling.
 */
export interface RollbackEvidenceRef {
    readonly id: Identifier;
    readonly receiptId: Identifier;
    readonly observationId: Identifier;
    readonly status?: EvidenceStatus;
}

/**
 * Evidence that can enter `stale` under `EVIDENCE_TRANSITIONS`. Evidence which
 * is already revoked, archived, purged or otherwise terminal is not planned
 * because it cannot legally transition to stale.
 */
export const ROLLBACK_STALEABLE_EVIDENCE_STATUSES: readonly EvidenceStatus[] = Object.freeze([
    "active",
    "corroborated",
    "stale",
    "pending_revalidation",
]);

/**
 * A reversible view of a workspace. The anchor belongs to the receipt being
 * rolled back to; restoring the snapshot itself is a host responsibility.
 */
export interface RollbackPlan {
    /** Receipt the rollback was requested for. */
    readonly receiptId: Identifier;
    /** The target, every subsequent receipt in scope, and causal descendants. */
    readonly receiptsToRevoke: readonly ReceiptCore[];
    /** Evidence directly attached to a revoked receipt and still staleable. */
    readonly evidenceToStale: readonly Identifier[];
    /** Snapshot coordinates restored before the receipts are revoked. */
    readonly workspaceAnchor?: WorkspaceAnchor;
}

/** Input passed once to the host revocation-propagation port. */
export interface RollbackPropagation {
    readonly receiptIds: readonly Identifier[];
    readonly evidenceIds: readonly Identifier[];
    readonly reason: string;
    readonly at: string;
}

/**
 * Host ports for applying a rollback. None of them may delete receipts: §9.3
 * requires a receipt to stay available after rollback and only change state.
 */
export interface RollbackPorts {
    /** Marks one receipt revoked; it must not remove the receipt. */
    readonly revokeReceipt: (receipt: ReceiptCore, at: string, reason: string) => void;
    /** Marks one evidence item stale and returns additionally invalidated evidence. */
    readonly markEvidenceStale: (evidenceId: Identifier, reason: string, at: string) => readonly Identifier[] | void;
    /** Propagates the revocation across dependent receipts and evidence. */
    readonly propagateRevocation: (propagation: RollbackPropagation) => readonly Identifier[] | void;
    /** Appends the rollback record to the evidence ledger as `system_rule` evidence. */
    readonly recordEvidence: (record: RollbackEvidenceRecord) => void;
    /** Injectable clock; defaults to the current wall-clock time. */
    readonly now?: () => string;
}

/** Evidence record emitted for every applied rollback (refract.md §9.4). */
export interface RollbackEvidenceRecord {
    readonly id: Identifier;
    readonly evidenceKind: "system_rule";
    readonly source: {
        readonly type: "system_rule";
        readonly reliability: number;
        readonly independenceKey: string;
    };
    readonly receiptId: Identifier;
    readonly workspaceAnchor?: WorkspaceAnchor;
    readonly revokedReceiptIds: readonly Identifier[];
    readonly staledEvidenceIds: readonly Identifier[];
    readonly propagatedIds: readonly Identifier[];
    readonly reason: string;
    readonly digest: string;
    readonly createdAt: string;
}

export interface RollbackApplication {
    readonly receiptId: Identifier;
    readonly revokedReceiptIds: readonly Identifier[];
    readonly staledEvidenceIds: readonly Identifier[];
    readonly propagatedIds: readonly Identifier[];
    readonly appliedAt: string;
    readonly evidence: RollbackEvidenceRecord;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function requireTimestamp(value: unknown, field: string): string {
    if (!isNonEmptyString(value) || !Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be an ISO-compatible timestamp`);
    return value;
}

function sessionOf(receipt: ReceiptCore): Identifier | undefined {
    return receipt.sessionId ?? receipt.invocation?.context?.sessionId;
}

function agentOf(receipt: ReceiptCore): Identifier | undefined {
    return receipt.agentId ?? receipt.invocation?.context?.agentId;
}

function sameWorkspace(left: ReceiptCore, right: ReceiptCore): boolean {
    const leftWorkspace = left.workspaceAnchor?.workspaceId;
    const rightWorkspace = right.workspaceAnchor?.workspaceId;
    return leftWorkspace !== undefined && rightWorkspace !== undefined && leftWorkspace === rightWorkspace;
}

/**
 * Whether `candidate` is subsequent to `target` in rollback scope.
 *
 * Rollback restores a workspace snapshot, so receipts sharing the target
 * workspace and issued at or after the target are subsequent regardless of
 * session. Without a workspace anchor, a later receipt in the same session is
 * subsequent; with neither coordinate, a later receipt from the same agent is.
 * Explicit `parentId` descendants are added separately and even when their
 * clock is skewed before the target.
 */
function isSubsequent(candidate: ReceiptCore, target: ReceiptCore): boolean {
    if (candidate.issuedAt < target.issuedAt) return false;
    if (sameWorkspace(candidate, target)) return true;
    const targetSession = sessionOf(target);
    if (targetSession !== undefined && sessionOf(candidate) === targetSession) return true;
    if (target.workspaceAnchor === undefined && targetSession === undefined) {
        const targetAgent = agentOf(target);
        if (targetAgent !== undefined && agentOf(candidate) === targetAgent) return true;
    }
    return false;
}

function compareReceiptOrder(left: ReceiptCore, right: ReceiptCore): number {
    return left.issuedAt.localeCompare(right.issuedAt) || left.id.localeCompare(right.id);
}

function isStaleable(evidence: RollbackEvidenceRef): boolean {
    return evidence.status === undefined || ROLLBACK_STALEABLE_EVIDENCE_STATUSES.includes(evidence.status);
}

function fnv1a(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

/**
 * Plans a rollback to a workspace snapshot taken before `receiptId`.
 *
 * The plan contains the target, subsequent receipts in rollback scope
 * (workspace, session, or agent as described by {@link isSubsequent}), every
 * transitive `parentId` descendant, and evidence directly attached to a revoked
 * receipt that can still enter `stale`. Receipts are never removed; the plan is
 * deeply frozen and deterministic regardless of input order.
 */
export function planRollback(
    receiptId: Identifier,
    receipts: readonly ReceiptCore[],
    evidence: readonly RollbackEvidenceRef[] = [],
): RollbackPlan {
    if (!isNonEmptyString(receiptId)) throw new TypeError("Rollback receiptId must be a non-empty identifier");
    if (!Array.isArray(receipts)) throw new TypeError("Rollback receipts must be an array");
    if (!Array.isArray(evidence)) throw new TypeError("Rollback evidence must be an array");

    const byId = new Map<Identifier, ReceiptCore>();
    for (const [index, receipt] of receipts.entries()) {
        if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) throw new TypeError(`Rollback receipt[${index}] must be an object`);
        if (!isNonEmptyString(receipt.id)) throw new TypeError(`Rollback receipt[${index}].id must be a non-empty identifier`);
        if (byId.has(receipt.id)) throw new RollbackError("duplicate_receipt", `duplicate receipt: ${receipt.id}`);
        byId.set(receipt.id, receipt);
    }
    const target = byId.get(receiptId);
    if (target === undefined) throw new RollbackError("receipt_not_found", `unknown receipt: ${receiptId}`);

    const selected = new Set<Identifier>([target.id]);
    for (const receipt of receipts) {
        if (receipt.id !== target.id && isSubsequent(receipt, target)) selected.add(receipt.id);
    }
    // Close over explicit causality even when a child clock is earlier than its parent.
    let expanded = true;
    while (expanded) {
        expanded = false;
        for (const receipt of receipts) {
            if (selected.has(receipt.id)) continue;
            if (receipt.parentId !== undefined && selected.has(receipt.parentId)) {
                selected.add(receipt.id);
                expanded = true;
            }
        }
    }

    const revokedReceipts = receipts.filter(receipt => selected.has(receipt.id)).sort(compareReceiptOrder);
    const revokedObservationIds = new Set(revokedReceipts.map(receipt => receipt.observation.id));
    const evidenceIds = evidence
        .filter((item, index) => {
            if (typeof item !== "object" || item === null || Array.isArray(item)) throw new TypeError(`Rollback evidence[${index}] must be an object`);
            if (!isNonEmptyString(item.id) || !isNonEmptyString(item.receiptId) || !isNonEmptyString(item.observationId)) {
                throw new TypeError(`Rollback evidence[${index}] requires id, receiptId and observationId`);
            }
            if (item.status !== undefined && !(EVIDENCE_STATUSES as readonly string[]).includes(item.status)) {
                throw new TypeError(`Rollback evidence[${index}] has an invalid status: ${String(item.status)}`);
            }
            return (selected.has(item.receiptId) || revokedObservationIds.has(item.observationId)) && isStaleable(item);
        })
        .map(item => item.id);
    const evidenceToStale = [...new Set(evidenceIds)].sort((left, right) => left.localeCompare(right));

    const plan = {
        receiptId,
        receiptsToRevoke: revokedReceipts,
        evidenceToStale,
        ...(target.workspaceAnchor === undefined ? {} : { workspaceAnchor: target.workspaceAnchor }),
    } as unknown as JsonValue;
    return immutableSnapshot(plan) as unknown as RollbackPlan;
}

/**
 * Applies a rollback plan through host ports:
 *
 * 1. every planned receipt is marked `revoked` (never deleted);
 * 2. every planned evidence item is marked `stale` and may invalidate dependents;
 * 3. revocation propagation runs once for the whole rollback;
 * 4. a `system_rule` evidence record for the rollback event is appended.
 *
 * The function is synchronous and returns a deeply frozen audit summary.
 */
export function applyRollback(plan: RollbackPlan, ports: RollbackPorts): RollbackApplication {
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) throw new RollbackError("invalid_plan", "rollback plan must be an object");
    if (!Array.isArray(plan.receiptsToRevoke) || plan.receiptsToRevoke.length === 0) {
        throw new RollbackError("invalid_plan", "rollback plan must contain at least the target receipt");
    }
    if (!isNonEmptyString(plan.receiptId)) throw new RollbackError("invalid_plan", "rollback plan receiptId must be a non-empty identifier");
    if (!Array.isArray(plan.evidenceToStale)) throw new RollbackError("invalid_plan", "rollback plan evidenceToStale must be an array");
    if (typeof ports !== "object" || ports === null || Array.isArray(ports)) throw new RollbackError("invalid_ports", "rollback ports must be an object");
    for (const port of ["revokeReceipt", "markEvidenceStale", "propagateRevocation", "recordEvidence"] as const) {
        if (typeof ports[port] !== "function") throw new RollbackError("invalid_ports", `rollback port ${port} must be a function`);
    }

    const appliedAt = requireTimestamp(ports.now?.() ?? new Date().toISOString(), "Rollback appliedAt");
    const reason = `rollback:${plan.receiptId}`;
    const revokedReceiptIds: Identifier[] = [];
    for (const receipt of plan.receiptsToRevoke) {
        if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt) || !isNonEmptyString(receipt.id)) {
            throw new RollbackError("invalid_plan", "rollback plan contains an invalid receipt");
        }
        ports.revokeReceipt(receipt, appliedAt, reason);
        revokedReceiptIds.push(receipt.id);
    }

    const staledEvidenceIds: Identifier[] = [];
    const propagated = new Set<Identifier>();
    for (const evidenceId of plan.evidenceToStale) {
        if (!isNonEmptyString(evidenceId)) throw new RollbackError("invalid_plan", "rollback plan contains an invalid evidence identifier");
        const dependents = ports.markEvidenceStale(evidenceId, reason, appliedAt);
        staledEvidenceIds.push(evidenceId);
        if (dependents !== undefined) for (const dependentId of dependents) if (isNonEmptyString(dependentId)) propagated.add(dependentId);
    }

    const propagatedByPort = ports.propagateRevocation({
        receiptIds: Object.freeze([...revokedReceiptIds]),
        evidenceIds: Object.freeze([...staledEvidenceIds]),
        reason,
        at: appliedAt,
    });
    if (propagatedByPort !== undefined) for (const propagatedId of propagatedByPort) if (isNonEmptyString(propagatedId)) propagated.add(propagatedId);

    const propagatedIds = [...propagated].sort((left, right) => left.localeCompare(right));
    const digest = fnv1a(JSON.stringify({
        receiptId: plan.receiptId,
        revokedReceiptIds,
        staledEvidenceIds,
        propagatedIds,
        workspaceAnchor: plan.workspaceAnchor ?? null,
        reason,
        appliedAt,
    }));
    const record: RollbackEvidenceRecord = Object.freeze({
        id: `receipt-rollback:${digest}`,
        evidenceKind: "system_rule",
        source: Object.freeze({
            type: "system_rule",
            reliability: 1,
            independenceKey: `system_rule:receipt_rollback:${plan.receiptId}:${digest}`,
        }),
        receiptId: plan.receiptId,
        ...(plan.workspaceAnchor === undefined ? {} : { workspaceAnchor: plan.workspaceAnchor }),
        revokedReceiptIds: Object.freeze([...revokedReceiptIds]),
        staledEvidenceIds: Object.freeze([...staledEvidenceIds]),
        propagatedIds: Object.freeze([...propagatedIds]),
        reason,
        digest,
        createdAt: appliedAt,
    });
    ports.recordEvidence(record);

    return Object.freeze({
        receiptId: plan.receiptId,
        revokedReceiptIds: Object.freeze([...revokedReceiptIds]),
        staledEvidenceIds: Object.freeze([...staledEvidenceIds]),
        propagatedIds: record.propagatedIds,
        appliedAt,
        evidence: record,
    });
}
