/**
 * Rebuildable, host-owned projection of warrant dependencies. No wire fields,
 * truth inference, persistence or permission ownership live here.
 */
import type { Claim } from "../warrant/epistemic.ts";
import type { Plan } from "../goal/plan.ts";
import type { Ref } from "../types/common.ts";
import { digestOf } from "../semantic/canonical.ts";
import { EvidenceGraph } from "./evidenceGraph.ts";
import type { EvidenceImpact } from "./evidenceGraph.ts";

interface ReferenceSource {
    kind: "ref";
    ref: Ref;
}

interface OriginSource {
    kind: "origin";
    id: string;
}

interface EvidenceSource {
    kind: "evidence";
    claimId: string;
    id: string;
}

export type WarrantSource = ReferenceSource | OriginSource | EvidenceSource;

export interface RevalidationImpact {
    claims: string[];
    plans: string[];
}

export interface ReviewToken {
    readonly claimId: string;
    readonly generation: number;
}

const sourceKey: (source: WarrantSource) => string = (source: WarrantSource): string => {
    if (source.kind === "ref") {
        return JSON.stringify(["ref", source.ref.kind, source.ref.id]);
    }
    return source.kind === "origin" ? JSON.stringify(["origin", source.id]) : JSON.stringify(["evidence", source.claimId, source.id]);
};
const claimSource: (id: string) => WarrantSource = (id: string): WarrantSource => ({ kind: "ref", ref: { kind: "claim", id } });

/**
 * Build from one authoritative ledger snapshot, then feed explicit changes.
 * Rebuild after adding/revising claims or plans; replay outstanding changes
 * before publishing the replacement projection. Unknown sources throw.
 *
 * Review methods are host APIs: completion asserts an external review, it does
 * not perform one. Tokens bind completion to the affected claim generation.
 */
export class WarrantRevalidation {
    private readonly graph: EvidenceGraph = new EvidenceGraph();
    private readonly claimIds: Map<string, string> = new Map<string, string>();
    private readonly fingerprints: Map<string, string> = new Map<string, string>();
    private readonly held: Set<string> = new Set<string>();
    private readonly parents: Map<string, Set<string>> = new Map<string, Set<string>>();
    private readonly planDependents: Map<string, Set<string>> = new Map<string, Set<string>>();
    private readonly generations: Map<string, number> = new Map<string, number>();
    private readonly pending: Set<string> = new Set<string>();
    private readonly reviews: WeakMap<ReviewToken, ReviewToken> = new WeakMap<ReviewToken, ReviewToken>();

    constructor(claims: readonly Claim[], plans: readonly Plan[] = []) {
        claims.forEach((claim: Claim) => {
            const key: string = sourceKey(claimSource(claim.id));
            this.graph.addClaim(key, claim.statement);
            this.claimIds.set(key, claim.id);
            this.fingerprints.set(claim.id, digestOf(claim));
            this.generations.set(claim.id, 0);
            if (claim.status === "held") {
                this.held.add(claim.id);
            }
        });
        const blocked: Map<string, WarrantSource> = new Map<string, WarrantSource>();
        claims.forEach((claim: Claim) => {
            const key: string = sourceKey(claimSource(claim.id));
            const parents: Set<string> = new Set<string>();
            this.parents.set(claim.id, parents);
            if (!this.held.has(claim.id)) {
                blocked.set(key, claimSource(claim.id));
            }
            claim.warrant.evidence.forEach((item: Claim["warrant"]["evidence"][number]) => {
                const itemKey: string = sourceKey({ kind: "evidence", claimId: claim.id, id: item.id });
                this.graph.addEvidence(itemKey, item.excerpt ?? item.id, key, item.trust);
                if (item.ref) {
                    const refSource: WarrantSource = { kind: "ref", ref: item.ref };
                    this.graph.link(this.ensureSource(refSource), itemKey);
                    if (item.ref.kind === "claim") {
                        parents.add(item.ref.id);
                        if (!this.held.has(item.ref.id)) {
                            blocked.set(sourceKey(refSource), refSource);
                        }
                    }
                }
                if (item.origin !== (void 0)) {
                    this.graph.link(this.ensureSource({ kind: "origin", id: item.origin }), itemKey);
                }
            });
        });
        const planIds: Set<string> = new Set<string>();
        plans.forEach((plan: Plan) => {
            if (planIds.has(plan.id)) {
                throw new Error(`duplicate plan ${plan.id}`);
            }
            planIds.add(plan.id);
            if (plan.warrant) {
                const key: string = this.ensureSource({ kind: "ref", ref: plan.warrant });
                const dependents: Set<string> = this.planDependents.get(key) ?? new Set<string>();
                dependents.add(plan.id);
                this.planDependents.set(key, dependents);
            }
        });
        this.invalidate([...blocked.values()]);
    }

    /**
     * All relations (support, contradiction, undercut) are dependencies of a
     * decision. Supersedes is history, not a support edge. Each change, including
     * a repeated notification, advances affected generations conservatively.
     */
    invalidate(sources: readonly WarrantSource[]): RevalidationImpact {
        const entries: EvidenceImpact[] = this.graph.impact(sources.map(sourceKey));
        const claims: string[] = [];
        const plans: Set<string> = new Set<string>();
        entries.forEach((entry: EvidenceImpact) => {
            const claimId: string | undefined = this.claimIds.get(entry.id);
            if (claimId !== (void 0)) {
                claims.push(claimId);
                this.pending.add(claimId);
                this.generations.set(claimId, (this.generations.get(claimId) as number) + 1);
            }
            this.planDependents.get(entry.id)?.forEach((planId: string) => {
                plans.add(planId);
            });
        });
        return { claims, plans: [...plans] };
    }

    /**
     * Check both dependency freshness and identity of the indexed claim body.
     * Unknown or modified claims fail closed; this does not authenticate a host.
     */
    isCurrent(claim: Claim): boolean {
        return this.fingerprints.get(claim.id) === digestOf(claim) && !this.pending.has(claim.id);
    }

    needsRevalidation(claimId: string): boolean {
        return !this.fingerprints.has(claimId) || this.pending.has(claimId);
    }

    beginReview(claimId: string): ReviewToken {
        const generation: number | undefined = this.generations.get(claimId);
        if (generation === (void 0)) {
            throw new Error(`unknown claim ${claimId}`);
        }
        const token: ReviewToken = Object.freeze({ claimId, generation });
        this.reviews.set(token, token);
        return token;
    }

    /**
     * The host calls this only after checking remaining support. A stale token,
     * unresolved/non-held antecedent, or fabricated token cannot clear pending.
     * A changed conclusion requires an appended revision and index rebuild.
     */
    completeReview(token: ReviewToken): boolean {
        const issued: ReviewToken | undefined = this.reviews.get(token);
        if (!issued || this.generations.get(issued.claimId) !== issued.generation) {
            return false;
        }
        const parents: string[] = [...(this.parents.get(issued.claimId) ?? [])];
        if (parents.some((parent: string) => !this.held.has(parent) || this.pending.has(parent))) {
            return false;
        }
        this.reviews.delete(token);
        this.pending.delete(issued.claimId);
        return true;
    }

    private ensureSource(source: WarrantSource): string {
        const key: string = sourceKey(source);
        if (!this.graph.get(key)) {
            this.graph.addSource(key, key);
        }
        return key;
    }
}
