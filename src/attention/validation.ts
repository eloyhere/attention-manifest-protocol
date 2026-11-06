import { Optional } from "semantic-typescript";
import type { Budget } from "../shared.ts";
import type { AttentionObject, AttentionPointer, AttentionScope } from "./types.ts";

export class AttentionError extends Error {
    readonly code: "invalid" | "version_conflict" | "expired" | "stale";
    constructor(code: AttentionError["code"], message: string) {
        super(message);
        this.name = "AttentionError";
        this.code = code;
    }
}

export function requireText(value: string, field: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new AttentionError("invalid", `${field} must be nonempty`);
    }
}

export function timestamp(value: string): number {
    requireText(value, "timestamp");
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new AttentionError("invalid", `Invalid timestamp: ${value}`);
    return parsed;
}

export function validateBudget(budget: Budget): void {
    for (const key of ["tokens", "milliseconds", "calls", "bytes"] as const) {
        Optional.ofNullable(budget[key]).ifPresent(value => {
            if (!Number.isFinite(value) || value < 0) throw new AttentionError("invalid", `Budget ${key} must be finite and nonnegative`);
        });
    }
}

export function validatePointer(pointer: AttentionPointer): void {
    requireText(pointer.id, "pointer.id");
    requireText(pointer.kind, "pointer.kind");
    requireText(pointer.version, "pointer.version");
}

export function validateScope(scope: AttentionScope): void {
    for (const key of ["tenantId", "principalId", "sessionId", "turnId"] as const) requireText(scope[key], key);
    Optional.ofNullable(scope.workspaceId).ifPresent(value => requireText(value, "workspaceId"));
    Optional.ofNullable(scope.projectId).ifPresent(value => requireText(value, "projectId"));
}

export function unitInterval(value: number, field: string): void {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new AttentionError("invalid", `${field} must be in [0, 1]`);
}

export function validateObject(object: AttentionObject): void {
    requireText(object.id, "id");
    requireText(object.summary, "summary");
    requireText(object.lastReason, "reason");
    if (!Number.isSafeInteger(object.version) || object.version < 1) throw new AttentionError("invalid", "Invalid object version");
    validatePointer(object.pointer);
    object.sources.forEach(validatePointer);
    Object.values(object.references).forEach(refs => refs.forEach(validatePointer));
    validateScope(object.scope);
    Object.entries(object.scores).forEach(([key, value]) => unitInterval(value, key));
    unitInterval(object.intensity, "intensity");
    validateBudget(object.budget);
    timestamp(object.expiresAt);
    timestamp(object.createdAt);
    timestamp(object.updatedAt);
    if (typeof object.mounted !== "boolean" || typeof object.stale !== "boolean") {
        throw new AttentionError("invalid", "Residency and staleness must be booleans");
    }
    if (timestamp(object.updatedAt) < timestamp(object.createdAt)) {
        throw new AttentionError("invalid", "Updated time predates creation");
    }
    Optional.ofNullable(object.retention).ifPresent(retention => {
        requireText(retention.reason, "retention.reason");
        validateBudget(retention.budget);
        if (Object.values(retention.budget).every(value => Optional.ofNullable(value).isEmpty())) {
            throw new AttentionError("invalid", "Retention needs an explicit budget limit");
        }
        if (timestamp(retention.expiresAt) > timestamp(object.expiresAt)) {
            throw new AttentionError("invalid", "Retention cannot outlive its source reference");
        }
        if (retention.across !== "steps" && retention.across !== "turns") {
            throw new AttentionError("invalid", "Invalid retention boundary");
        }
    });
}

/** Scope can be retained across Turns, but never across tenant, principal or workspace. */
export function inScope(object: AttentionObject, scope: AttentionScope, now: string): boolean {
    const own = object.scope;
    return own.tenantId === scope.tenantId
        && own.principalId === scope.principalId
        && own.sessionId === scope.sessionId
        && own.workspaceId === scope.workspaceId
        && own.projectId === scope.projectId
        && (own.turnId === scope.turnId || Optional.ofNullable(object.retention)
            .map(retention => retention.across === "turns" && timestamp(retention.expiresAt) > timestamp(now)).get(false));
}

export function isExpired(object: AttentionObject, now: string): boolean {
    return timestamp(object.expiresAt) <= timestamp(now);
}
