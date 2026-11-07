import { Optional, SynchronousUnorderedMap, SynchronousUnorderedSet, useFrom } from "semantic-typescript";
import type { Identifier } from "../shared.ts";
import type {
    AddEvidenceInput,
    Evidence,
    EvidenceCause,
    EvidenceLevel,
    EvidenceSource,
    EvidenceSourceType,
    EvidenceStatus,
    ProvenanceEvent,
} from "./types.ts";
import { EVIDENCE_LEVELS, EVIDENCE_SOURCE_TYPES } from "./types.ts";

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOptionalIdentifier(field: string, value: unknown): void {
    if (value !== undefined && !isNonEmptyString(value)) throw new TypeError(`Evidence ${field} must be a non-empty identifier`);
}

function validateIdArray(field: string, value: unknown, selfId: Identifier): readonly Identifier[] {
    if (!Array.isArray(value)) throw new TypeError(`Evidence ${field} must be an array`);
    const seen = new Set<string>();
    for (const item of value) {
        if (!isNonEmptyString(item)) throw new TypeError(`Evidence ${field} must contain non-empty identifiers`);
        if (item === selfId) throw new TypeError(`Evidence ${field} cannot reference itself`);
        if (seen.has(item)) throw new TypeError(`Evidence ${field} contains duplicate identifier: ${item}`);
        seen.add(item);
    }
    return Object.freeze([...value]) as readonly Identifier[];
}

function normalizeLevel(value: unknown): EvidenceLevel {
    if (!(EVIDENCE_LEVELS as readonly string[]).includes(value as string)) throw new TypeError(`invalid evidence level: ${String(value)}`);
    return value as EvidenceLevel;
}

function normalizeSource(value: unknown): EvidenceSource {
    if (!isRecord(value)) throw new TypeError("Evidence source must be an object");
    if (!(EVIDENCE_SOURCE_TYPES as readonly string[]).includes(value.type as string)) throw new TypeError(`invalid evidence source type: ${String(value.type)}`);
    if (typeof value.reliability !== "number" || !Number.isFinite(value.reliability) || value.reliability < 0 || value.reliability > 1) throw new TypeError("Evidence source reliability must be a finite number between 0 and 1");
    if (value.origin !== undefined && value.origin !== "original" && value.origin !== "secondary") throw new TypeError(`invalid evidence source origin: ${String(value.origin)}`);
    if (value.reproducible !== undefined && typeof value.reproducible !== "boolean") throw new TypeError("Evidence source reproducible must be a boolean");
    validateOptionalIdentifier("source.sourceId", value.sourceId);
    validateOptionalIdentifier("source.domain", value.domain);
    validateOptionalIdentifier("source.tool", value.tool);
    validateOptionalIdentifier("source.instruction", value.instruction);
    validateOptionalIdentifier("source.independenceKey", value.independenceKey);
    return Object.freeze({
        type: value.type as EvidenceSourceType,
        reliability: value.reliability,
        ...(value.sourceId === undefined ? {} : { sourceId: value.sourceId as Identifier }),
        ...(value.domain === undefined ? {} : { domain: value.domain as string }),
        ...(value.tool === undefined ? {} : { tool: value.tool as Identifier }),
        ...(value.instruction === undefined ? {} : { instruction: value.instruction as string }),
        ...(value.origin === undefined ? {} : { origin: value.origin as "original" | "secondary" }),
        ...(value.reproducible === undefined ? {} : { reproducible: value.reproducible as boolean }),
        ...(value.independenceKey === undefined ? {} : { independenceKey: value.independenceKey as string }),
    });
}

function normalizeFreshness(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new TypeError("Evidence freshnessScore must be a finite number between 0 and 1");
    return value;
}

function isConsumableStatus(status: EvidenceStatus): boolean {
    return status === "active" || status === "corroborated";
}

function isStaleableStatus(status: EvidenceStatus): boolean {
    return status === "active" || status === "corroborated" || status === "stale" || status === "pending_revalidation";
}

export class EvidenceLedger {
    private readonly evidence = new SynchronousUnorderedMap<Identifier, Evidence>();
    private readonly dependents = new SynchronousUnorderedMap<Identifier, SynchronousUnorderedSet<Identifier>>();
    private readonly invalidated = new SynchronousUnorderedSet<Identifier>();
    private readonly eventLog: ProvenanceEvent[] = [];

    add(input: AddEvidenceInput): Evidence {
        if (!input.id || !input.tenantId || !input.claim || !input.environmentVersion) throw new TypeError("Evidence identity and scope are required");
        const createdAt = Date.parse(input.createdAt);
        if (!Number.isFinite(createdAt)) throw new TypeError("Evidence createdAt must be an ISO-compatible timestamp");
        const expiresAt = input.expiresAt === undefined ? undefined : Date.parse(input.expiresAt);
        if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= createdAt)) throw new TypeError("Evidence expiresAt must be valid and later than createdAt");
        if (input.receipt.invocation.context.tenantId !== input.tenantId) throw new TypeError("Receipt tenant must match evidence tenant");
        if (input.integrity.receiptId !== input.receipt.id || input.integrity.status !== "integrity_verified") throw new TypeError("Evidence requires integrity-verified receipt");
        if (input.verification.receiptId !== input.receipt.id || input.verification.observationId !== input.receipt.observation.id || input.verification.status !== "semantic_verified") throw new TypeError("Evidence requires matching semantic verification");
        if (input.criteriaVersion !== input.verification.criteriaVersion) throw new TypeError("Evidence criteria version must match verification");
        if (!input.verification.claims.includes(input.claim)) throw new TypeError("Verification must explicitly cover the evidence claim");
        if (this.evidence.containsKey(input.id)) throw new TypeError(`Duplicate evidence: ${input.id}`);
        const dependencies = Object.freeze(useFrom(input.dependsOn ?? []).distinct().toCollectable().toArray());
        if (dependencies.includes(input.id)) throw new TypeError("Evidence cannot depend on itself");
        for (const dependencyId of dependencies) {
            const dependency = this.get(dependencyId, input.tenantId);
            if (!dependency || dependency.tenantId !== input.tenantId || !isConsumableStatus(dependency.status)) throw new TypeError(`Unknown, invalid, or cross-tenant evidence dependency: ${dependencyId}`);
        }
        const level = input.level === undefined ? undefined : normalizeLevel(input.level);
        for (const field of ["parentId", "agentId", "cooperationId", "sessionId", "turnId"] as const) validateOptionalIdentifier(field, input[field]);
        const source = input.source === undefined ? undefined : normalizeSource(input.source);
        const corroborationIds = input.corroborationIds === undefined ? undefined : validateIdArray("corroborationIds", input.corroborationIds, input.id);
        const consumedBy = input.consumedBy === undefined ? undefined : validateIdArray("consumedBy", input.consumedBy, input.id);
        validateOptionalIdentifier("supersededBy", input.supersededBy);
        if (input.supersededBy === input.id) throw new TypeError("Evidence supersededBy cannot reference itself");
        const freshnessScore = input.freshnessScore === undefined ? undefined : normalizeFreshness(input.freshnessScore);
        const evidence: Evidence = Object.freeze({
            id: input.id,
            tenantId: input.tenantId,
            dependsOn: dependencies,
            claim: input.claim,
            polarity: input.polarity,
            observationId: input.receipt.observation.id,
            receiptId: input.receipt.id,
            verificationId: input.verification.id,
            integrityVerificationId: input.integrity.id,
            criteriaVersion: input.criteriaVersion,
            environmentVersion: input.environmentVersion,
            createdAt: input.createdAt,
            ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
            status: "active",
            ...(level === undefined ? {} : { level }),
            ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
            ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
            ...(input.cooperationId === undefined ? {} : { cooperationId: input.cooperationId }),
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
            ...(source === undefined ? {} : { source }),
            ...(corroborationIds === undefined ? {} : { corroborationIds }),
            ...(consumedBy === undefined ? {} : { consumedBy }),
            ...(input.supersededBy === undefined ? {} : { supersededBy: input.supersededBy }),
            ...(freshnessScore === undefined ? {} : { freshnessScore }),
        });
        this.evidence.put(evidence.id, evidence);
        this.link(input.tenantId, input.receipt.id, evidence.id);
        this.link(input.tenantId, input.receipt.observation.id, evidence.id);
        this.link(input.tenantId, input.integrity.id, evidence.id);
        this.link(input.tenantId, input.verification.id, evidence.id);
        this.link(input.tenantId, input.environmentVersion, evidence.id);
        for (const dependencyId of dependencies) this.link(input.tenantId, dependencyId, evidence.id);
        for (const consumerId of consumedBy ?? []) this.link(input.tenantId, evidence.id, consumerId);
        for (const dependentId of consumedBy ?? []) this.link(input.tenantId, dependentId, evidence.id);
        this.eventLog.push(Object.freeze({ type: "evidence_added", evidenceId: evidence.id, at: input.createdAt }));
        return evidence;
    }

    get(id: Identifier, tenantId: Identifier): Evidence | undefined {
        const evidence = this.stored(id);
        return evidence?.tenantId === tenantId ? evidence : undefined;
    }

    find(id: Identifier, tenantId: Identifier): Optional<Evidence> {
        return Optional.ofNullable(this.get(id, tenantId));
    }

    revoke(evidenceId: Identifier, tenantId: Identifier, reason: string, at: string): readonly Identifier[];
    /** Tenant-less form derives the tenant from the stored evidence record. */
    revoke(evidenceId: Identifier, reason: string, at?: string): readonly Identifier[];
    revoke(evidenceId: Identifier, tenantIdOrReason: Identifier, reasonOrAt?: string, at?: string): readonly Identifier[] {
        let tenantId: Identifier;
        let reason: string;
        let timestamp: string;
        if (at !== undefined && reasonOrAt !== undefined) {
            tenantId = tenantIdOrReason;
            reason = reasonOrAt;
            timestamp = at;
        } else {
            const evidence = this.stored(evidenceId);
            if (!evidence) throw new TypeError(`Unknown evidence: ${evidenceId}`);
            tenantId = evidence.tenantId;
            reason = tenantIdOrReason;
            timestamp = reasonOrAt ?? evidence.createdAt;
        }
        if (!this.get(evidenceId, tenantId)) throw new TypeError(`Unknown evidence: ${evidenceId}`);
        return this.invalidate([evidenceId], tenantId, "revoked", reason, timestamp);
    }

    /**
     * Records independent corroboration. Evidence sharing an `independenceKey`
     * with the target is the same origin and is deduplicated rather than counted
     * twice; re-recording the same witness is likewise a no-op.
     */
    corroborate(evidenceId: Identifier, byId: Identifier, at?: string): Evidence {
        const target = this.stored(evidenceId);
        const corroborator = this.stored(byId);
        if (!target) throw new TypeError(`Unknown evidence: ${evidenceId}`);
        if (!corroborator) throw new TypeError(`Unknown evidence: ${byId}`);
        if (target.tenantId !== corroborator.tenantId) throw new TypeError("Cross-tenant evidence corroboration");
        if (target.id === corroborator.id) throw new TypeError("Evidence cannot corroborate itself");
        if (!isConsumableStatus(target.status)) throw new TypeError(`Evidence is not corroboratable: ${target.id}`);
        if (!isConsumableStatus(corroborator.status)) throw new TypeError(`Evidence is not corroboratable: ${corroborator.id}`);
        const independenceKey = target.source?.independenceKey;
        if (independenceKey !== undefined && independenceKey === corroborator.source?.independenceKey) return target;
        if (target.corroborationIds?.includes(byId)) return target;
        const corroborationIds = Object.freeze([...(target.corroborationIds ?? []), byId]);
        const updated: Evidence = Object.freeze({ ...target, status: "corroborated", corroborationIds });
        this.evidence.put(evidenceId, updated);
        this.eventLog.push(Object.freeze({ type: "evidence_corroborated", evidenceId, byId, at: at ?? corroborator.createdAt }));
        return updated;
    }

    /** Marks evidence stale and propagates invalidation; repeated calls are idempotent. */
    markStale(evidenceId: Identifier, tenantId: Identifier, reason: string, at: string): readonly Identifier[];
    /** Tenant-less form derives the tenant from the stored evidence record. */
    markStale(evidenceId: Identifier, reason: string, at?: string): readonly Identifier[];
    markStale(evidenceId: Identifier, tenantIdOrReason: Identifier, reasonOrAt?: string, at?: string): readonly Identifier[] {
        let tenantId: Identifier;
        let reason: string;
        let timestamp: string;
        if (at !== undefined && reasonOrAt !== undefined) {
            tenantId = tenantIdOrReason;
            reason = reasonOrAt;
            timestamp = at;
        } else {
            const stored = this.stored(evidenceId);
            if (!stored) throw new TypeError(`Unknown evidence: ${evidenceId}`);
            tenantId = stored.tenantId;
            reason = tenantIdOrReason;
            timestamp = reasonOrAt ?? stored.createdAt;
        }
        const evidence = this.get(evidenceId, tenantId);
        if (!evidence) throw new TypeError(`Unknown evidence: ${evidenceId}`);
        if (!isStaleableStatus(evidence.status)) throw new TypeError(`Evidence cannot be marked stale from ${evidence.status}: ${evidenceId}`);
        return this.invalidate([evidenceId], tenantId, "stale", reason, timestamp);
    }

    invalidateCause(cause: EvidenceCause, reason: string, at: string): readonly Identifier[] {
        const roots = this.dependents.get(this.dependencyKey(cause.tenantId, cause.id));
        if (!roots.isPresent()) return Object.freeze([]);
        const ids = roots.get();
        return this.invalidate([...ids], cause.tenantId, cause.kind === "environment" ? "stale" : "pending_revalidation", reason, at, cause.id);
    }

    getConsumable(id: Identifier, tenantId: Identifier, now: string): Evidence | undefined {
        const nowTime = Date.parse(now);
        if (!Number.isFinite(nowTime)) return undefined;
        const evidence = this.stored(id);
        if (evidence === undefined) return undefined;
        if (evidence.tenantId !== tenantId || !isConsumableStatus(evidence.status) || this.invalidated.contains(id)) return undefined;
        if (evidence.expiresAt && Date.parse(evidence.expiresAt) <= nowTime) return undefined;
        for (const dependencyId of evidence.dependsOn) if (!this.getConsumable(dependencyId, tenantId, now)) return undefined;
        return evidence;
    }

    findConsumable(id: Identifier, tenantId: Identifier, now: string): Optional<Evidence> {
        return Optional.ofNullable(this.getConsumable(id, tenantId, now));
    }

    auditEvents(): readonly ProvenanceEvent[] { return Object.freeze(useFrom(this.eventLog).toCollectable().toArray()); }

    private stored(id: Identifier): Evidence | undefined {
        const stored = this.evidence.get(id);
        return stored.isPresent() ? stored.get() : undefined;
    }

    private dependencyKey(tenantId: Identifier, source: Identifier): Identifier { return `${tenantId.length}:${tenantId}${source}`; }
    private link(tenantId: Identifier, source: Identifier, dependent: Identifier): void {
        const key = this.dependencyKey(tenantId, source);
        const current = this.dependents.get(key);
        const targets = current.isPresent() ? current.get() : new SynchronousUnorderedSet<Identifier>();
        targets.add(dependent);
        if (!current.isPresent()) this.dependents.put(key, targets);
    }
    private invalidate(roots: readonly Identifier[], tenantId: Identifier, status: Exclude<EvidenceStatus, "active">, reason: string, at: string, sourceId?: Identifier): readonly Identifier[] {
        const queue = new SynchronousUnorderedSet<Identifier>(roots);
        const visited = new SynchronousUnorderedSet<Identifier>();
        const order: Identifier[] = [];
        while (!queue.isEmpty()) {
            const id = [...queue][0];
            queue.remove(id);
            if (visited.contains(id)) continue;
            visited.add(id);
            order.push(id);
            const dependents = this.dependents.get(this.dependencyKey(tenantId, id));
            if (dependents.isPresent()) for (const dependentId of dependents.get()) if (!visited.contains(dependentId)) queue.add(dependentId);
        }
        const changed = new SynchronousUnorderedSet<Identifier>();
        for (const id of order) {
            const evidence = this.stored(id);
            if (evidence === undefined || evidence.tenantId !== tenantId) continue;
            const isRevocationRoot = id === roots[0] && status === "revoked";
            const nextStatus: EvidenceStatus = isRevocationRoot ? "revoked" : status === "revoked" ? "pending_revalidation" : status;
            this.invalidated.add(id);
            if (evidence.status === nextStatus) continue;
            this.evidence.put(id, Object.freeze({ ...evidence, status: nextStatus }));
            changed.add(id);
            this.eventLog.push(Object.freeze({ type: nextStatus === "revoked" ? "evidence_revoked" : "evidence_staled", evidenceId: id, reason, at }));
        }
        if (sourceId) {
            for (const id of order) {
                const dependents = this.dependents.get(this.dependencyKey(tenantId, id));
                if (dependents.isPresent()) for (const dependentId of dependents.get()) {
                    if (changed.contains(dependentId)) this.eventLog.push(Object.freeze({ type: "dependency_invalidated", sourceId, dependentId, at }));
                }
            }
        }
        return Object.freeze(order);
    }
}
