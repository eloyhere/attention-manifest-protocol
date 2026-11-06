import { Optional } from "semantic-typescript";
import type { AttentionObject, AttentionOperationOptions, AttentionRetention, AttentionUpdate, AttentionVerificationInput, CreateAttentionInput } from "./types.ts";
import { AttentionError, isExpired, requireText, timestamp, unitInterval, validateObject, validatePointer } from "./validation.ts";

/** Pure L2/L3 operations. The host owns storage/CAS and the unified budget ledger. */
export function createAttention(input: CreateAttentionInput, now: string): AttentionObject {
    timestamp(now);
    const object: AttentionObject = {
        ...structuredClone(input),
        version: 1,
        sources: structuredClone(Optional.ofNullable(input.sources).get([])),
        references: {
            evidence: structuredClone(Optional.ofNullable(input.references).flatMap(refs => Optional.ofNullable(refs.evidence)).get([])),
            receipts: structuredClone(Optional.ofNullable(input.references).flatMap(refs => Optional.ofNullable(refs.receipts)).get([])),
            capabilities: structuredClone(Optional.ofNullable(input.references).flatMap(refs => Optional.ofNullable(refs.capabilities)).get([])),
            behaviors: structuredClone(Optional.ofNullable(input.references).flatMap(refs => Optional.ofNullable(refs.behaviors)).get([])),
        },
        scores: { relevance: 0, urgency: 0, confidence: 0, importance: 0, ...input.scores },
        intensity: 0.5,
        mounted: false,
        stale: false,
        createdAt: now,
        updatedAt: now,
        lastReason: input.reason,
    };
    validateObject(object);
    if (isExpired(object, now)) throw new AttentionError("expired", "New attention is already expired");
    return object;
}

function revise(object: AttentionObject, options: AttentionOperationOptions, allowInactive = false): AttentionObject {
    validateObject(object);
    timestamp(options.now);
    requireText(options.reason, "reason");
    if (object.version !== options.expectedVersion) throw new AttentionError("version_conflict", "Attention version changed");
    if (object.version >= Number.MAX_SAFE_INTEGER) throw new AttentionError("invalid", "Attention version exhausted");
    if (timestamp(options.now) < timestamp(object.updatedAt)) throw new AttentionError("invalid", "Operation predates current version");
    if (!allowInactive && isExpired(object, options.now)) throw new AttentionError("expired", "Attention is expired");
    if (!allowInactive && object.stale) throw new AttentionError("stale", "Refresh stale attention first");
    return { ...structuredClone(object), version: object.version + 1, updatedAt: options.now, lastReason: options.reason, assessment: undefined };
}

/** Raises ranking only; mounting and execution authorization remain independent. */
export function focus(object: AttentionObject, options: AttentionOperationOptions, amount = 0.25): AttentionObject {
    unitInterval(amount, "amount");
    return { ...revise(object, options), intensity: Math.min(1, object.intensity + amount) };
}

/** Keeps summary and mount status; blur is not unmount. */
export function blur(object: AttentionObject, options: AttentionOperationOptions, amount = 0.25): AttentionObject {
    unitInterval(amount, "amount");
    return { ...revise(object, options, true), intensity: Math.max(0, object.intensity - amount) };
}

export function mount(object: AttentionObject, options: AttentionOperationOptions): AttentionObject {
    return { ...revise(object, options), mounted: true };
}

export function unmount(object: AttentionObject, options: AttentionOperationOptions): AttentionObject {
    return { ...revise(object, options, true), mounted: false };
}

/** Retains metadata/references only. An explicit budget, expiry and reason are mandatory. */
export function persist(object: AttentionObject, retention: AttentionRetention, options: AttentionOperationOptions): AttentionObject {
    const next = { ...revise(object, options), retention: structuredClone(retention) };
    validateObject(next);
    if (timestamp(retention.expiresAt) <= timestamp(options.now)) throw new AttentionError("expired", "Retention is already expired");
    return next;
}

/** Refreshing content invalidates prior assessments; it never mutates the domain fact. */
export function update(object: AttentionObject, patch: AttentionUpdate, options: AttentionOperationOptions): AttentionObject {
    const base = revise(object, options, true);
    const next: AttentionObject = {
        ...base,
        summary: Optional.ofNullable(patch.summary).get(base.summary),
        pointer: structuredClone(Optional.ofNullable(patch.pointer).get(base.pointer)),
        sources: structuredClone(Optional.ofNullable(patch.sources).get(base.sources)),
        budget: structuredClone(Optional.ofNullable(patch.budget).get(base.budget)),
        expiresAt: Optional.ofNullable(patch.expiresAt).get(base.expiresAt),
        stale: Optional.ofNullable(patch.stale).get(base.stale),
        references: { ...base.references, ...structuredClone(Optional.ofNullable(patch.references).get({})) },
        scores: { ...base.scores, ...patch.scores },
        assessment: undefined,
    };
    validateObject(next);
    if (isExpired(next, options.now)) throw new AttentionError("expired", "Updated attention is expired");
    return next;
}

/** Records a version-bound ranking assessment, never an L6/business success result. */
export function verify(object: AttentionObject, input: AttentionVerificationInput, options: AttentionOperationOptions): AttentionObject {
    const next = revise(object, options);
    validatePointer(input.verifier);
    input.evidence.forEach(validatePointer);
    unitInterval(input.posterior, "posterior");
    if (!["retain", "review", "suppress"].includes(input.recommendation)) throw new AttentionError("invalid", "Invalid recommendation");
    if (input.sourceVersion !== object.pointer.version) throw new AttentionError("version_conflict", "Assessment targets another source version");
    return {
        ...next,
        assessment: {
            ...structuredClone(input),
            assessedAt: options.now,
            objectVersion: next.version,
            reason: options.reason,
            businessVerified: false,
        },
    };
}
