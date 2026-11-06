import { Optional, SynchronousUnorderedMap, SynchronousUnorderedSet, useFrom } from "semantic-typescript";
import type { Identifier } from "../shared.ts";
import type { AddEvidenceInput, Evidence, EvidenceCause, EvidenceStatus, ProvenanceEvent } from "./types.ts";

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
            if (!dependency || dependency.tenantId !== input.tenantId || dependency.status !== "active") throw new TypeError(`Unknown, invalid, or cross-tenant evidence dependency: ${dependencyId}`);
        }
        const evidence: Evidence = Object.freeze({ id: input.id, tenantId: input.tenantId, dependsOn: dependencies, claim: input.claim, polarity: input.polarity, observationId: input.receipt.observation.id, receiptId: input.receipt.id, verificationId: input.verification.id, integrityVerificationId: input.integrity.id, criteriaVersion: input.criteriaVersion, environmentVersion: input.environmentVersion, createdAt: input.createdAt, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}), status: "active" });
        this.evidence.put(evidence.id, evidence);
        this.link(input.tenantId, input.receipt.id, evidence.id);
        this.link(input.tenantId, input.receipt.observation.id, evidence.id);
        this.link(input.tenantId, input.integrity.id, evidence.id);
        this.link(input.tenantId, input.verification.id, evidence.id);
        this.link(input.tenantId, input.environmentVersion, evidence.id);
        for (const dependencyId of dependencies) this.link(input.tenantId, dependencyId, evidence.id);
        this.eventLog.push(Object.freeze({ type: "evidence_added", evidenceId: evidence.id, at: input.createdAt }));
        return evidence;
    }

    get(id: Identifier, tenantId: Identifier): Evidence | undefined {
        const stored = this.evidence.get(id);
        if (!stored.isPresent()) return undefined;
        const evidence = stored.get();
        return evidence.tenantId === tenantId ? evidence : undefined;
    }

    find(id: Identifier, tenantId: Identifier): Optional<Evidence> {
        return Optional.ofNullable(this.get(id, tenantId));
    }

    revoke(evidenceId: Identifier, tenantId: Identifier, reason: string, at: string): readonly Identifier[] {
        if (!this.get(evidenceId, tenantId)) throw new TypeError(`Unknown evidence: ${evidenceId}`);
        return this.invalidate([evidenceId], tenantId, "revoked", reason, at);
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
        const stored = this.evidence.get(id);
        if (!stored.isPresent()) return undefined;
        const evidence = stored.get();
        if (evidence.tenantId !== tenantId || evidence.status !== "active" || this.invalidated.contains(id)) return undefined;
        if (evidence.expiresAt && Date.parse(evidence.expiresAt) <= nowTime) return undefined;
        for (const dependencyId of evidence.dependsOn) if (!this.getConsumable(dependencyId, tenantId, now)) return undefined;
        return evidence;
    }

    findConsumable(id: Identifier, tenantId: Identifier, now: string): Optional<Evidence> {
        return Optional.ofNullable(this.getConsumable(id, tenantId, now));
    }

    auditEvents(): readonly ProvenanceEvent[] { return Object.freeze(useFrom(this.eventLog).toCollectable().toArray()); }

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
        while (!queue.isEmpty()) {
            const id = [...queue][0];
            queue.remove(id);
            if (visited.contains(id)) continue;
            visited.add(id);
            const stored = this.evidence.get(id);
            if (stored.isPresent()) {
                const evidence = stored.get();
                const isRevocationRoot = id === roots[0] && status === "revoked";
                const nextStatus: EvidenceStatus = isRevocationRoot ? "revoked" : status === "revoked" ? "pending_revalidation" : status;
                this.evidence.put(id, Object.freeze({ ...evidence, status: nextStatus }));
                this.invalidated.add(id);
                this.eventLog.push(Object.freeze({ type: nextStatus === "revoked" ? "evidence_revoked" : "evidence_staled", evidenceId: id, reason, at }));
            }
            const dependents = this.dependents.get(this.dependencyKey(tenantId, id));
            if (dependents.isPresent()) for (const dependentId of dependents.get()) {
                if (!visited.contains(dependentId)) queue.add(dependentId);
                if (sourceId) this.eventLog.push(Object.freeze({ type: "dependency_invalidated", sourceId, dependentId, at }));
            }
        }
        return Object.freeze([...visited]);
    }
}
